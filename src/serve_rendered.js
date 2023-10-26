'use strict';

import advancedPool from 'advanced-pool';
import fs from 'node:fs';
import path from 'path';
import url from 'url';
import util from 'util';
import zlib from 'zlib';
import sharp from 'sharp'; // sharp has to be required before node-canvas on linux but after it on windows. see https://github.com/lovell/sharp/issues/371
import { createCanvas, Image } from 'canvas';
import clone from 'clone';
import Color from 'color';
import express from 'express';
import sanitize from 'sanitize-filename';
import SphericalMercator from '@mapbox/sphericalmercator';
import mlgl from '@maplibre/maplibre-gl-native';
import MBTiles from '@mapbox/mbtiles';
import polyline from '@mapbox/polyline';
import proj4 from 'proj4';
import request from 'request';
import {
  getFontsPbf,
  getTileUrls,
  isValidHttpUrl,
  fixTileJSONCenter,
  generateMarker,
} from './utils.js';
import {
  PMtilesOpen,
  GetPMtilesInfo,
  GetPMtilesTile,
} from './pmtiles_adapter.js';

const FLOAT_PATTERN = '[+-]?(?:\\d+|\\d+.?\\d+)';
const PATH_PATTERN =
  /^((fill|stroke|width)\:[^\|]+\|)*(enc:.+|-?\d+(\.\d*)?,-?\d+(\.\d*)?(\|-?\d+(\.\d*)?,-?\d+(\.\d*)?)+)/;
const httpTester = /^(http(s)?:)?\/\//;

const mercator = new SphericalMercator();
const getScale = (scale) => (scale || '@1x').slice(1, 2) | 0;

mlgl.on('message', (e) => {
  if (e.severity === 'WARNING' || e.severity === 'ERROR') {
    console.log('mlgl:', e);
  }
});

/**
 * Lookup of sharp output formats by file extension.
 */
const extensionToFormat = {
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.webp': 'webp',
};

/**
 * Cache of response data by sharp output format and color.  Entry for empty
 * string is for unknown or unsupported formats.
 */
const cachedEmptyResponses = {
  '': Buffer.alloc(0),
};

/**
 * Create an appropriate mlgl response for http errors.
 * @param {string} format The format (a sharp format or 'pbf').
 * @param {string} color The background color (or empty string for transparent).
 * @param {Function} callback The mlgl callback.
 */
function createEmptyResponse(format, color, callback) {
  if (!format || format === 'pbf') {
    callback(null, { data: cachedEmptyResponses[''] });
    return;
  }

  if (format === 'jpg') {
    format = 'jpeg';
  }
  if (!color) {
    color = 'rgba(255,255,255,0)';
  }

  const cacheKey = `${format},${color}`;
  const data = cachedEmptyResponses[cacheKey];
  if (data) {
    callback(null, { data: data });
    return;
  }

  // create an "empty" response image
  color = new Color(color);
  const array = color.array();
  const channels = array.length === 4 && format !== 'jpeg' ? 4 : 3;
  sharp(Buffer.from(array), {
    raw: {
      width: 1,
      height: 1,
      channels: channels,
    },
  })
    .toFormat(format)
    .toBuffer((err, buffer, info) => {
      if (!err) {
        cachedEmptyResponses[cacheKey] = buffer;
      }
      callback(null, { data: buffer });
    });
}

/**
 * Parses coordinate pair provided to pair of floats and ensures the resulting
 * pair is a longitude/latitude combination depending on lnglat query parameter.
 * @param {List} coordinatePair Coordinate pair.
 * @param coordinates
 * @param {object} query Request query parameters.
 */
const parseCoordinatePair = (coordinates, query) => {
  const firstCoordinate = parseFloat(coordinates[0]);
  const secondCoordinate = parseFloat(coordinates[1]);

  // Ensure provided coordinates could be parsed and abort if not
  if (isNaN(firstCoordinate) || isNaN(secondCoordinate)) {
    return null;
  }

  // Check if coordinates have been provided as lat/lng pair instead of the
  // ususal lng/lat pair and ensure resulting pair is lng/lat
  if (query.latlng === '1' || query.latlng === 'true') {
    return [secondCoordinate, firstCoordinate];
  }

  return [firstCoordinate, secondCoordinate];
};

/**
 * Parses a coordinate pair from query arguments and optionally transforms it.
 * @param {List} coordinatePair Coordinate pair.
 * @param {object} query Request query parameters.
 * @param {Function} transformer Optional transform function.
 */
const parseCoordinates = (coordinatePair, query, transformer) => {
  const parsedCoordinates = parseCoordinatePair(coordinatePair, query);

  // Transform coordinates
  if (transformer) {
    return transformer(parsedCoordinates);
  }

  return parsedCoordinates;
};

/**
 * Parses paths provided via query into a list of path objects.
 * @param {object} query Request query parameters.
 * @param {Function} transformer Optional transform function.
 */
const extractPathsFromQuery = (query, transformer) => {
  // Initiate paths array
  const paths = [];
  // Return an empty list if no paths have been provided
  if ('path' in query && !query.path) {
    return paths;
  }
  // Parse paths provided via path query argument
  if ('path' in query) {
    const providedPaths = Array.isArray(query.path) ? query.path : [query.path];
    // Iterate through paths, parse and validate them
    for (const providedPath of providedPaths) {
      // Logic for pushing coords to path when path includes google polyline
      if (providedPath.includes('enc:') && PATH_PATTERN.test(providedPath)) {
        // +4 because 'enc:' is 4 characters, everything after 'enc:' is considered to be part of the polyline
        const encIndex = providedPath.indexOf('enc:') + 4;
        const coords = polyline
          .decode(providedPath.substring(encIndex))
          .map(([lat, lng]) => [lng, lat]);
        paths.push(coords);
      } else {
        // Iterate through paths, parse and validate them
        const currentPath = [];

        // Extract coordinate-list from path
        const pathParts = (providedPath || '').split('|');

        // Iterate through coordinate-list, parse the coordinates and validate them
        for (const pair of pathParts) {
          // Extract coordinates from coordinate pair
          const pairParts = pair.split(',');
          // Ensure we have two coordinates
          if (pairParts.length === 2) {
            const pair = parseCoordinates(pairParts, query, transformer);

            // Ensure coordinates could be parsed and skip them if not
            if (pair === null) {
              continue;
            }

            // Add the coordinate-pair to the current path if they are valid
            currentPath.push(pair);
          }
        }
        // Extend list of paths with current path if it contains coordinates
        if (currentPath.length) {
          paths.push(currentPath);
        }
      }
    }
  }
  return paths;
};

/**
 * Parses marker options provided via query and sets corresponding attributes
 * on marker object.
 * Options adhere to the following format
 * [optionName]:[optionValue]
 * @param {List[String]} optionsList List of option strings.
 * @param {object} marker Marker object to configure.
 */
const parseMarkerOptions = (optionsList, marker) => {
  for (const options of optionsList) {
    const optionParts = options.split(':');
    // Ensure we got an option name and value
    if (optionParts.length < 2) {
      continue;
    }

    switch (optionParts[0]) {
      // Scale factor to up- or downscale icon
      case 'scale':
        // Scale factors must not be negative
        marker.scale = Math.abs(parseFloat(optionParts[1]));
        break;
      // Icon offset as positive or negative pixel value in the following
      // format [offsetX],[offsetY] where [offsetY] is optional
      case 'offset':
        const providedOffset = optionParts[1].split(',');
        // Set X-axis offset
        marker.offsetX = parseFloat(providedOffset[0]);
        // Check if an offset has been provided for Y-axis
        if (providedOffset.length > 1) {
          marker.offsetY = parseFloat(providedOffset[1]);
        }
        break;
      // Custom color when using default marker
      case 'color':
        marker.color = String(optionParts[1]);
        break;
    }
  }
};

/**
 * Parses markers provided via query into a list of marker objects.
 * @param {object} query Request query parameters.
 * @param {object} options Configuration options.
 * @param {Function} transformer Optional transform function.
 */
const extractMarkersFromQuery = (query, options, transformer) => {
  // Return an empty list if no markers have been provided
  if (!query.marker) {
    return [];
  }

  const markers = [];

  // Check if multiple markers have been provided and mimic a list if it's a
  // single maker.
  const providedMarkers = Array.isArray(query.marker)
    ? query.marker
    : [query.marker];

  // Iterate through provided markers which can have one of the following
  // formats
  // [location]|[pathToFileTelativeToConfiguredIconPath]
  // [location]|[pathToFile...]|[option]|[option]|...
  for (const providedMarker of providedMarkers) {
    const markerParts = providedMarker.split('|');
    // Ensure we got at least a location and an icon uri
    if (markerParts.length < 2) {
      continue;
    }

    const locationParts = markerParts[0].split(',');
    // Ensure the locationParts contains two items
    if (locationParts.length !== 2) {
      continue;
    }

    let iconURI = markerParts[1];

    // Check if icon is served via http otherwise marker icons are expected to
    // be provided as filepaths relative to configured icon path
    const isDefaultMarker = iconURI === 'default';
    const isRemoteURL = iconURI.startsWith('http://') || iconURI.startsWith('https://');
    const isDataURL = iconURI.startsWith('data:');

    if (isDefaultMarker) {
      iconURI = 'default'; // use built-in marker
    } else if (!(isRemoteURL || isDataURL)) {
      // Sanitize URI with sanitize-filename
      // https://www.npmjs.com/package/sanitize-filename#details
      iconURI = sanitize(iconURI);

      // If the selected icon is not part of available icons skip it
      if (!options.paths.availableIcons.includes(iconURI)) {
        continue;
      }

      iconURI = path.resolve(options.paths.icons, iconURI);

      // When we encounter a remote icon check if the configuration explicitly allows them.
    } else if (isRemoteURL && options.allowRemoteMarkerIcons !== true) {
      continue; // skip
    } else if (isDataURL && options.allowInlineMarkerImages !== true) {
      continue; // skip
    }

    // Ensure marker location could be parsed
    const location = parseCoordinates(locationParts, query, transformer);
    if (location === null) {
      continue;
    }

    const marker = {};

    marker.location = location;
    marker.icon = iconURI;

    // Check if options have been provided
    if (markerParts.length > 2) {
      parseMarkerOptions(markerParts.slice(2), marker);
    }

    // Add marker to list
    markers.push(marker);
  }
  return markers;
};

/**
 * Transforms coordinates to pixels.
 * @param {List[Number]} ll Longitude/Latitude coordinate pair.
 * @param {number} zoom Map zoom level.
 */
const precisePx = (ll, zoom) => {
  const px = mercator.px(ll, 20);
  const scale = Math.pow(2, zoom - 20);
  return [px[0] * scale, px[1] * scale];
};

/**
 * Draws a marker in cavans context.
 * @param {object} ctx Canvas context object.
 * @param {object} marker Marker object parsed by extractMarkersFromQuery.
 * @param {number} z Map zoom level.
 */
const drawMarker = (ctx, marker, z, scale) => {
  return new Promise(async (resolve) => {
    const img = new Image();
    const pixelCoords = precisePx(marker.location, z);

    let imgSrc = marker.icon;
    if (marker.icon === 'default') {
      // use default built-in marker (svg -> dataURL)
      const markerDataURL = await generateMarker(scale, marker.color);
      marker.scale = marker.scale ? marker.scale * (1 / scale) : 1 / scale;
      imgSrc = markerDataURL;
    }

    const getMarkerCoordinates = (imageWidth, imageHeight, scale) => {
      // Images are placed with their top-left corner at the provided location
      // within the canvas but we expect icons to be centered and above it.

      // Substract half of the images width from the x-coordinate to center
      // the image in relation to the provided location
      let xCoordinate = pixelCoords[0] - imageWidth / 2;
      // Substract the images height from the y-coordinate to place it above
      // the provided location
      let yCoordinate = pixelCoords[1] - imageHeight;

      // Since image placement is dependent on the size offsets have to be
      // scaled as well. Additionally offsets are provided as either positive or
      // negative values so we always add them
      if (marker.offsetX) {
        xCoordinate = xCoordinate + marker.offsetX * scale;
      }
      if (marker.offsetY) {
        yCoordinate = yCoordinate + marker.offsetY * scale;
      }

      return {
        x: xCoordinate,
        y: yCoordinate,
      };
    };

    const drawOnCanvas = () => {
      // Check if the images should be resized before beeing drawn
      const defaultScale = 1;
      const scale = marker.scale ? marker.scale : defaultScale;

      // Calculate scaled image sizes
      const imageWidth = img.width * scale;
      const imageHeight = img.height * scale;

      // Pass the desired sizes to get correlating coordinates
      const coords = getMarkerCoordinates(imageWidth, imageHeight, scale);

      // Draw the image on canvas
      if (scale != defaultScale) {
        ctx.drawImage(img, coords.x, coords.y, imageWidth, imageHeight);
      } else {
        ctx.drawImage(img, coords.x, coords.y);
      }
      // Resolve the promise when image has been drawn
      resolve();
    };

    img.onload = drawOnCanvas;
    img.src = imgSrc;
    img.onerror = (err) => {
      throw err;
    };
  });
};

/**
 * Draws a list of markers onto a canvas.
 * Wraps drawing of markers into list of promises and awaits them.
 * It's required because images are expected to load asynchronous in canvas js
 * even when provided from a local disk.
 * @param {object} ctx Canvas context object.
 * @param {List[Object]} markers Marker objects parsed by extractMarkersFromQuery.
 * @param {number} z Map zoom level.
 */
const drawMarkers = async (ctx, markers, z, scale) => {
  const markerPromises = [];

  for (const marker of markers) {
    // Begin drawing marker
    markerPromises.push(drawMarker(ctx, marker, z, scale));
  }

  // Await marker drawings before continuing
  await Promise.all(markerPromises);
};

/**
 * Draws a list of coordinates onto a canvas and styles the resulting path.
 * @param {object} ctx Canvas context object.
 * @param {List[Number]} path List of coordinates.
 * @param {object} query Request query parameters.
 * @param {string} pathQuery Path query parameter.
 * @param {number} z Map zoom level.
 */
const drawPath = (ctx, path, query, pathQuery, z) => {
  const splitPaths = pathQuery.split('|');

  if (!path || path.length < 2) {
    return null;
  }

  ctx.beginPath();

  // Transform coordinates to pixel on canvas and draw lines between points
  for (const pair of path) {
    const px = precisePx(pair, z);
    ctx.lineTo(px[0], px[1]);
  }

  // Check if first coordinate matches last coordinate
  if (
    path[0][0] === path[path.length - 1][0] &&
    path[0][1] === path[path.length - 1][1]
  ) {
    ctx.closePath();
  }

  // Optionally fill drawn shape with a rgba color from query
  const pathHasFill = splitPaths.filter((x) => x.startsWith('fill')).length > 0;
  if (query.fill !== undefined || pathHasFill) {
    if ('fill' in query) {
      ctx.fillStyle = query.fill || 'rgba(255,255,255,0.4)';
    }
    if (pathHasFill) {
      ctx.fillStyle = splitPaths
        .find((x) => x.startsWith('fill:'))
        .replace('fill:', '');
    }
    ctx.fill();
  }

  // Get line width from query and fall back to 1 if not provided
  const pathHasWidth =
    splitPaths.filter((x) => x.startsWith('width')).length > 0;
  if (query.width !== undefined || pathHasWidth) {
    let lineWidth = 1;
    // Get line width from query
    if ('width' in query) {
      lineWidth = Number(query.width);
    }
    // Get line width from path in query
    if (pathHasWidth) {
      lineWidth = Number(
        splitPaths.find((x) => x.startsWith('width:')).replace('width:', ''),
      );
    }
    // Get border width from query and fall back to 10% of line width
    const borderWidth =
      query.borderwidth !== undefined
        ? parseFloat(query.borderwidth)
        : lineWidth * 0.1;

    // Set rendering style for the start and end points of the path
    // https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/lineCap
    ctx.lineCap = query.linecap || 'butt';

    // Set rendering style for overlapping segments of the path with differing directions
    // https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/lineJoin
    ctx.lineJoin = query.linejoin || 'miter';

    // In order to simulate a border we draw the path two times with the first
    // beeing the wider border part.
    if (query.border !== undefined && borderWidth > 0) {
      // We need to double the desired border width and add it to the line width
      // in order to get the desired border on each side of the line.
      ctx.lineWidth = lineWidth + borderWidth * 2;
      // Set border style as rgba
      ctx.strokeStyle = query.border;
      ctx.stroke();
    }
    ctx.lineWidth = lineWidth;
  }

  const pathHasStroke =
    splitPaths.filter((x) => x.startsWith('stroke')).length > 0;
  if (query.stroke !== undefined || pathHasStroke) {
    if ('stroke' in query) {
      ctx.strokeStyle = query.stroke;
    }
    // Path Stroke gets higher priority
    if (pathHasStroke) {
      ctx.strokeStyle = splitPaths
        .find((x) => x.startsWith('stroke:'))
        .replace('stroke:', '');
    }
  } else {
    ctx.strokeStyle = 'rgba(0,64,255,0.7)';
  }
  ctx.stroke();
};

const renderOverlay = async (
  z,
  x,
  y,
  bearing,
  pitch,
  w,
  h,
  scale,
  paths,
  markers,
  query,
) => {
  if ((!paths || paths.length === 0) && (!markers || markers.length === 0)) {
    return null;
  }

  const center = precisePx([x, y], z);

  const mapHeight = 512 * (1 << z);
  const maxEdge = center[1] + h / 2;
  const minEdge = center[1] - h / 2;
  if (maxEdge > mapHeight) {
    center[1] -= maxEdge - mapHeight;
  } else if (minEdge < 0) {
    center[1] -= minEdge;
  }

  const canvas = createCanvas(scale * w, scale * h);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  if (bearing) {
    ctx.translate(w / 2, h / 2);
    ctx.rotate((-bearing / 180) * Math.PI);
    ctx.translate(-center[0], -center[1]);
  } else {
    // optimized path
    ctx.translate(-center[0] + w / 2, -center[1] + h / 2);
  }

  // Draw provided paths if any
  paths.forEach((path, i) => {
    const pathQuery = Array.isArray(query.path) ? query.path.at(i) : query.path;
    drawPath(ctx, path, query, pathQuery, z);
  });

  // Await drawing of markers before rendering the canvas
  await drawMarkers(ctx, markers, z, scale);

  return canvas.toBuffer();
};

const calcZForBBox = (bbox, w, h, query) => {
  let z = 25;

  const padding = query.padding !== undefined ? parseFloat(query.padding) : 0.1;

  const minCorner = mercator.px([bbox[0], bbox[3]], z);
  const maxCorner = mercator.px([bbox[2], bbox[1]], z);
  const w_ = w / (1 + 2 * padding);
  const h_ = h / (1 + 2 * padding);

  z -=
    Math.max(
      Math.log((maxCorner[0] - minCorner[0]) / w_),
      Math.log((maxCorner[1] - minCorner[1]) / h_),
    ) / Math.LN2;

  z = Math.max(Math.log(Math.max(w, h) / 256) / Math.LN2, Math.min(25, z));

  return z;
};

const existingFonts = {};
let maxScaleFactor = 2;

export const serve_rendered = {
  init: (options, repo) => {
    const fontListingPromise = new Promise((resolve, reject) => {
      fs.readdir(options.paths.fonts, (err, files) => {
        if (err) {
          reject(err);
          return;
        }
        for (const file of files) {
          fs.stat(path.join(options.paths.fonts, file), (err, stats) => {
            if (err) {
              reject(err);
              return;
            }
            if (stats.isDirectory()) {
              existingFonts[path.basename(file)] = true;
            }
          });
        }
        resolve();
      });
    });

    maxScaleFactor = Math.min(Math.floor(options.maxScaleFactor || 3), 9);
    let scalePattern = '';
    for (let i = 2; i <= maxScaleFactor; i++) {
      scalePattern += i.toFixed();
    }
    scalePattern = `@[${scalePattern}]x`;

    const app = express().disable('x-powered-by');

    const respondImage = (
      item,
      z,
      lon,
      lat,
      bearing,
      pitch,
      width,
      height,
      scale,
      format,
      res,
      next,
      opt_overlay,
      opt_mode = 'tile',
    ) => {
      if (
        Math.abs(lon) > 180 ||
        Math.abs(lat) > 85.06 ||
        lon !== lon ||
        lat !== lat
      ) {
        return res.status(400).send('Invalid center');
      }

      if (
        Math.min(width, height) <= 0 ||
        Math.max(width, height) * scale > (options.maxSize || 2048) ||
        width !== width ||
        height !== height
      ) {
        return res.status(400).send('Invalid size');
      }

      if (format === 'png' || format === 'webp') {
      } else if (format === 'jpg' || format === 'jpeg') {
        format = 'jpeg';
      } else {
        return res.status(400).send('Invalid format');
      }

      const tileMargin = Math.max(options.tileMargin || 0, 0);
      let pool;
      if (opt_mode === 'tile' && tileMargin === 0) {
        pool = item.map.renderers[scale];
      } else {
        pool = item.map.renderers_static[scale];
      }
      pool.acquire((err, renderer) => {
        const mlglZ = Math.max(0, z - 1);
        const params = {
          zoom: mlglZ,
          center: [lon, lat],
          bearing: bearing,
          pitch: pitch,
          width: width,
          height: height,
        };

        if (z === 0) {
          params.width *= 2;
          params.height *= 2;
        }

        if (z > 2 && tileMargin > 0) {
          params.width += tileMargin * 2;
          params.height += tileMargin * 2;
        }

        renderer.render(params, (err, data) => {
          pool.release(renderer);
          if (err) {
            console.error(err);
            return res
              .status(500)
              .header('Content-Type', 'text/plain')
              .send(err);
          }

          // Fix semi-transparent outlines on raw, premultiplied input
          // https://github.com/maptiler/tileserver-gl/issues/350#issuecomment-477857040
          for (let i = 0; i < data.length; i += 4) {
            const alpha = data[i + 3];
            const norm = alpha / 255;
            if (alpha === 0) {
              data[i] = 0;
              data[i + 1] = 0;
              data[i + 2] = 0;
            } else {
              data[i] = data[i] / norm;
              data[i + 1] = data[i + 1] / norm;
              data[i + 2] = data[i + 2] / norm;
            }
          }

          const image = sharp(data, {
            raw: {
              width: params.width * scale,
              height: params.height * scale,
              channels: 4,
            },
          });

          if (z > 2 && tileMargin > 0) {
            const [_, y] = mercator.px(params.center, z);
            let yoffset = Math.max(
              Math.min(0, y - 128 - tileMargin),
              y + 128 + tileMargin - Math.pow(2, z + 8),
            );
            image.extract({
              left: tileMargin * scale,
              top: (tileMargin + yoffset) * scale,
              width: width * scale,
              height: height * scale,
            });
          }

          if (z === 0) {
            // HACK: when serving zoom 0, resize the 0 tile from 512 to 256
            image.resize(width * scale, height * scale);
          }

          var composite_array = [];
          if (opt_overlay) {
            composite_array.push({ input: opt_overlay });
          }
          if (item.watermark) {
            const canvas = createCanvas(scale * width, scale * height);
            const ctx = canvas.getContext('2d');
            ctx.scale(scale, scale);
            ctx.font = '10px sans-serif';
            ctx.strokeWidth = '1px';
            ctx.strokeStyle = 'rgba(255,255,255,.4)';
            ctx.strokeText(item.watermark, 5, height - 5);
            ctx.fillStyle = 'rgba(0,0,0,.4)';
            ctx.fillText(item.watermark, 5, height - 5);

            composite_array.push({ input: canvas.toBuffer() });
          }

          if (opt_mode === 'static' && item.staticAttributionText) {
            const canvas = createCanvas(scale * width, scale * height);
            const ctx = canvas.getContext('2d');
            ctx.scale(scale, scale);

            ctx.font = '10px sans-serif';
            const text = item.staticAttributionText;
            const textMetrics = ctx.measureText(text);
            const textWidth = textMetrics.width;
            const textHeight = 14;

            const padding = 6;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
            ctx.fillRect(
              width - textWidth - padding,
              height - textHeight - padding,
              textWidth + padding,
              textHeight + padding,
            );
            ctx.fillStyle = 'rgba(0,0,0,.8)';
            ctx.fillText(
              item.staticAttributionText,
              width - textWidth - padding / 2,
              height - textHeight + 8,
            );

            composite_array.push({ input: canvas.toBuffer() });
          }

          if (composite_array.length > 0) {
            image.composite(composite_array);
          }

          const formatQuality = (options.formatQuality || {})[format];

          if (format === 'png') {
            image.png({ adaptiveFiltering: false });
          } else if (format === 'jpeg') {
            image.jpeg({ quality: formatQuality || 80 });
          } else if (format === 'webp') {
            image.webp({ quality: formatQuality || 90 });
          }
          image.toBuffer((err, buffer, info) => {
            if (!buffer) {
              return res.status(404).send('Not found');
            }

            res.set({
              'Last-Modified': item.lastModified,
              'Content-Type': `image/${format}`,
            });
            return res.status(200).send(buffer);
          });
        });
      });
    };

    app.get(
      `/:id/:z(\\d+)/:x(\\d+)/:y(\\d+):scale(${scalePattern})?.:format([\\w]+)`,
      (req, res, next) => {
        const item = repo[req.params.id];
        if (!item) {
          return res.sendStatus(404);
        }

        const modifiedSince = req.get('if-modified-since');
        const cc = req.get('cache-control');
        if (modifiedSince && (!cc || cc.indexOf('no-cache') === -1)) {
          if (new Date(item.lastModified) <= new Date(modifiedSince)) {
            return res.sendStatus(304);
          }
        }

        const z = req.params.z | 0;
        const x = req.params.x | 0;
        const y = req.params.y | 0;
        const scale = getScale(req.params.scale);
        const format = req.params.format;
        if (
          z < 0 ||
          x < 0 ||
          y < 0 ||
          z > 22 ||
          x >= Math.pow(2, z) ||
          y >= Math.pow(2, z)
        ) {
          return res.status(404).send('Out of bounds');
        }
        const tileSize = 256;
        const tileCenter = mercator.ll(
          [
            ((x + 0.5) / (1 << z)) * (256 << z),
            ((y + 0.5) / (1 << z)) * (256 << z),
          ],
          z,
        );
        return respondImage(
          item,
          z,
          tileCenter[0],
          tileCenter[1],
          0,
          0,
          tileSize,
          tileSize,
          scale,
          format,
          res,
          next,
        );
      },
    );

    if (options.serveStaticMaps !== false) {
      const staticPattern = `/:id/static/:raw(raw)?/%s/:width(\\d+)x:height(\\d+):scale(${scalePattern})?.:format([\\w]+)`;

      const centerPattern = util.format(
        ':x(%s),:y(%s),:z(%s)(@:bearing(%s)(,:pitch(%s))?)?',
        FLOAT_PATTERN,
        FLOAT_PATTERN,
        FLOAT_PATTERN,
        FLOAT_PATTERN,
        FLOAT_PATTERN,
      );

      app.get(
        util.format(staticPattern, centerPattern),
        async (req, res, next) => {
          try {
            const item = repo[req.params.id];
            if (!item) {
              return res.sendStatus(404);
            }

            // override attribution text
            if (req.query.attributionText) {
              item.staticAttributionText = req.query.attributionText;
            }

            const raw = req.params.raw;
            const z = +req.params.z;
            let x = +req.params.x;
            let y = +req.params.y;
            const bearing = +(req.params.bearing || '0');
            const pitch = +(req.params.pitch || '0');
            const w = req.params.width | 0;
            const h = req.params.height | 0;
            const scale = getScale(req.params.scale);
            const format = req.params.format;

            if (z < 0) {
              return res.status(404).send('Invalid zoom');
            }

            const transformer = raw
              ? mercator.inverse.bind(mercator)
              : item.dataProjWGStoInternalWGS;

            if (transformer) {
              const ll = transformer([x, y]);
              x = ll[0];
              y = ll[1];
            }

            const paths = extractPathsFromQuery(req.query, transformer);
            const markers = extractMarkersFromQuery(
              req.query,
              options,
              transformer,
            );
            const overlay = await renderOverlay(
              z,
              x,
              y,
              bearing,
              pitch,
              w,
              h,
              scale,
              paths,
              markers,
              req.query,
            );

            return respondImage(
              item,
              z,
              x,
              y,
              bearing,
              pitch,
              w,
              h,
              scale,
              format,
              res,
              next,
              overlay,
              'static',
            );
          } catch (e) {
            next(e);
          }
        },
      );

      const serveBounds = async (req, res, next) => {
        try {
          const item = repo[req.params.id];
          if (!item) {
            return res.sendStatus(404);
          }
          const raw = req.params.raw;
          const bbox = [
            +req.params.minx,
            +req.params.miny,
            +req.params.maxx,
            +req.params.maxy,
          ];
          let center = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];

          const transformer = raw
            ? mercator.inverse.bind(mercator)
            : item.dataProjWGStoInternalWGS;

          if (transformer) {
            const minCorner = transformer(bbox.slice(0, 2));
            const maxCorner = transformer(bbox.slice(2));
            bbox[0] = minCorner[0];
            bbox[1] = minCorner[1];
            bbox[2] = maxCorner[0];
            bbox[3] = maxCorner[1];
            center = transformer(center);
          }

          const w = req.params.width | 0;
          const h = req.params.height | 0;
          const scale = getScale(req.params.scale);
          const format = req.params.format;

          const z = calcZForBBox(bbox, w, h, req.query);
          const x = center[0];
          const y = center[1];
          const bearing = 0;
          const pitch = 0;

          const paths = extractPathsFromQuery(req.query, transformer);
          const markers = extractMarkersFromQuery(
            req.query,
            options,
            transformer,
          );
          const overlay = await renderOverlay(
            z,
            x,
            y,
            bearing,
            pitch,
            w,
            h,
            scale,
            paths,
            markers,
            req.query,
          );
          return respondImage(
            item,
            z,
            x,
            y,
            bearing,
            pitch,
            w,
            h,
            scale,
            format,
            res,
            next,
            overlay,
            'static',
          );
        } catch (e) {
          next(e);
        }
      };

      const boundsPattern = util.format(
        ':minx(%s),:miny(%s),:maxx(%s),:maxy(%s)',
        FLOAT_PATTERN,
        FLOAT_PATTERN,
        FLOAT_PATTERN,
        FLOAT_PATTERN,
      );

      app.get(util.format(staticPattern, boundsPattern), serveBounds);

      app.get('/:id/static/', (req, res, next) => {
        for (const key in req.query) {
          req.query[key.toLowerCase()] = req.query[key];
        }
        req.params.raw = true;
        req.params.format = (req.query.format || 'image/png').split('/').pop();
        const bbox = (req.query.bbox || '').split(',');
        req.params.minx = bbox[0];
        req.params.miny = bbox[1];
        req.params.maxx = bbox[2];
        req.params.maxy = bbox[3];
        req.params.width = req.query.width || '256';
        req.params.height = req.query.height || '256';
        if (req.query.scale) {
          req.params.width /= req.query.scale;
          req.params.height /= req.query.scale;
          req.params.scale = `@${req.query.scale}`;
        }

        return serveBounds(req, res, next);
      });

      const autoPattern = 'auto';

      app.get(
        util.format(staticPattern, autoPattern),
        async (req, res, next) => {
          try {
            const item = repo[req.params.id];
            if (!item) {
              return res.sendStatus(404);
            }
            const raw = req.params.raw;
            const w = req.params.width | 0;
            const h = req.params.height | 0;
            const bearing = 0;
            const pitch = 0;
            const scale = getScale(req.params.scale);
            const format = req.params.format;

            const transformer = raw
              ? mercator.inverse.bind(mercator)
              : item.dataProjWGStoInternalWGS;

            const paths = extractPathsFromQuery(req.query, transformer);
            const markers = extractMarkersFromQuery(
              req.query,
              options,
              transformer,
            );

            // Extract coordinates from markers
            const markerCoordinates = [];
            for (const marker of markers) {
              markerCoordinates.push(marker.location);
            }

            // Create array with coordinates from markers and path
            const coords = [].concat(paths.flat()).concat(markerCoordinates);

            // Check if we have at least one coordinate to calculate a bounding box
            if (coords.length < 1) {
              return res.status(400).send('No coordinates provided');
            }

            const bbox = [Infinity, Infinity, -Infinity, -Infinity];
            for (const pair of coords) {
              bbox[0] = Math.min(bbox[0], pair[0]);
              bbox[1] = Math.min(bbox[1], pair[1]);
              bbox[2] = Math.max(bbox[2], pair[0]);
              bbox[3] = Math.max(bbox[3], pair[1]);
            }

            const bbox_ = mercator.convert(bbox, '900913');
            const center = mercator.inverse([
              (bbox_[0] + bbox_[2]) / 2,
              (bbox_[1] + bbox_[3]) / 2,
            ]);

            // Calculate zoom level
            const maxZoom = parseFloat(req.query.maxzoom);
            let z = calcZForBBox(bbox, w, h, req.query);
            if (maxZoom > 0) {
              z = Math.min(z, maxZoom);
            }

            const x = center[0];
            const y = center[1];

            const overlay = await renderOverlay(
              z,
              x,
              y,
              bearing,
              pitch,
              w,
              h,
              scale,
              paths,
              markers,
              req.query,
            );

            return respondImage(
              item,
              z,
              x,
              y,
              bearing,
              pitch,
              w,
              h,
              scale,
              format,
              res,
              next,
              overlay,
              'static',
            );
          } catch (e) {
            next(e);
          }
        },
      );
    }

    app.get('/:id.json', (req, res, next) => {
      const item = repo[req.params.id];
      if (!item) {
        return res.sendStatus(404);
      }
      const info = clone(item.tileJSON);
      info.tiles = getTileUrls(
        req,
        info.tiles,
        `styles/${req.params.id}`,
        info.format,
        item.publicUrl,
      );
      return res.send(info);
    });

    return Promise.all([fontListingPromise]).then(() => app);
  },
  add: async (options, repo, params, id, publicUrl, dataResolver) => {
    const map = {
      renderers: [],
      renderers_static: [],
      sources: {},
      source_types: {},
    };

    let styleJSON;
    const createPool = (ratio, mode, min, max) => {
      const createRenderer = (ratio, createCallback) => {
        const renderer = new mlgl.Map({
          mode: mode,
          ratio: ratio,
          request: async (req, callback) => {
            const protocol = req.url.split(':')[0];
            // console.log('Handling request:', req);
            if (protocol === 'sprites') {
              const dir = options.paths[protocol];
              const file = unescape(req.url).substring(protocol.length + 3);
              fs.readFile(path.join(dir, file), (err, data) => {
                callback(err, { data: data });
              });
            } else if (protocol === 'fonts') {
              const parts = req.url.split('/');
              const fontstack = unescape(parts[2]);
              const range = parts[3].split('.')[0];
              getFontsPbf(
                null,
                options.paths[protocol],
                fontstack,
                range,
                existingFonts,
              ).then(
                (concated) => {
                  callback(null, { data: concated });
                },
                (err) => {
                  callback(err, { data: null });
                },
              );
            } else if (protocol === 'mbtiles' || protocol === 'pmtiles') {
              const parts = req.url.split('/');
              const sourceId = parts[2];
              const source = map.sources[sourceId];
              const source_type = map.source_types[sourceId];
              const sourceInfo = styleJSON.sources[sourceId];

              const z = parts[3] | 0;
              const x = parts[4] | 0;
              const y = parts[5].split('.')[0] | 0;
              const format = parts[5].split('.')[1];

              if (source_type === 'pmtiles') {
                let tileinfo = await GetPMtilesTile(source, z, x, y);
                let data = tileinfo.data;
                let headers = tileinfo.header;
                if (data == undefined) {
                  if (options.verbose)
                    console.log('MBTiles error, serving empty', err);
                  createEmptyResponse(
                    sourceInfo.format,
                    sourceInfo.color,
                    callback,
                  );
                  return;
                } else {
                  const response = {};
                  response.data = data;
                  if (headers['Last-Modified']) {
                    response.modified = new Date(headers['Last-Modified']);
                  }

                  if (format === 'pbf') {
                    if (options.dataDecoratorFunc) {
                      response.data = options.dataDecoratorFunc(
                        sourceId,
                        'data',
                        response.data,
                        z,
                        x,
                        y,
                      );
                    }
                  }

                  callback(null, response);
                }
              } else if (source_type === 'mbtiles') {
                source.getTile(z, x, y, (err, data, headers) => {
                  if (err) {
                    if (options.verbose)
                      console.log('MBTiles error, serving empty', err);
                    createEmptyResponse(
                      sourceInfo.format,
                      sourceInfo.color,
                      callback,
                    );
                    return;
                  }

                  const response = {};
                  if (headers['Last-Modified']) {
                    response.modified = new Date(headers['Last-Modified']);
                  }

                  if (format === 'pbf') {
                    try {
                      response.data = zlib.unzipSync(data);
                    } catch (err) {
                      console.log(
                        'Skipping incorrect header for tile mbtiles://%s/%s/%s/%s.pbf',
                        id,
                        z,
                        x,
                        y,
                      );
                    }
                    if (options.dataDecoratorFunc) {
                      response.data = options.dataDecoratorFunc(
                        sourceId,
                        'data',
                        response.data,
                        z,
                        x,
                        y,
                      );
                    }
                  } else {
                    response.data = data;
                  }

                  callback(null, response);
                });
              }
            } else if (protocol === 'http' || protocol === 'https') {
              request(
                {
                  url: req.url,
                  encoding: null,
                  gzip: true,
                },
                (err, res, body) => {
                  const parts = url.parse(req.url);
                  const extension = path.extname(parts.pathname).toLowerCase();
                  const format = extensionToFormat[extension] || '';
                  if (err || res.statusCode < 200 || res.statusCode >= 300) {
                    // console.log('HTTP error', err || res.statusCode);
                    createEmptyResponse(format, '', callback);
                    return;
                  }

                  const response = {};
                  if (res.headers.modified) {
                    response.modified = new Date(res.headers.modified);
                  }
                  if (res.headers.expires) {
                    response.expires = new Date(res.headers.expires);
                  }
                  if (res.headers.etag) {
                    response.etag = res.headers.etag;
                  }

                  response.data = body;
                  callback(null, response);
                },
              );
            }
          },
        });
        renderer.load(styleJSON);
        createCallback(null, renderer);
      };
      return new advancedPool.Pool({
        min: min,
        max: max,
        create: createRenderer.bind(null, ratio),
        destroy: (renderer) => {
          renderer.release();
        },
      });
    };

    const styleFile = params.style;
    const styleJSONPath = path.resolve(options.paths.styles, styleFile);
    try {
      styleJSON = JSON.parse(fs.readFileSync(styleJSONPath));
    } catch (e) {
      console.log('Error parsing style file');
      return false;
    }

    if (styleJSON.sprite && !httpTester.test(styleJSON.sprite)) {
      styleJSON.sprite =
        'sprites://' +
        styleJSON.sprite
          .replace('{style}', path.basename(styleFile, '.json'))
          .replace(
            '{styleJsonFolder}',
            path.relative(options.paths.sprites, path.dirname(styleJSONPath)),
          );
    }
    if (styleJSON.glyphs && !httpTester.test(styleJSON.glyphs)) {
      styleJSON.glyphs = `fonts://${styleJSON.glyphs}`;
    }

    for (const layer of styleJSON.layers || []) {
      if (layer && layer.paint) {
        // Remove (flatten) 3D buildings
        if (layer.paint['fill-extrusion-height']) {
          layer.paint['fill-extrusion-height'] = 0;
        }
        if (layer.paint['fill-extrusion-base']) {
          layer.paint['fill-extrusion-base'] = 0;
        }
      }
    }

    const tileJSON = {
      tilejson: '2.0.0',
      name: styleJSON.name,
      attribution: '',
      minzoom: 0,
      maxzoom: 20,
      bounds: [-180, -85.0511, 180, 85.0511],
      format: 'png',
      type: 'baselayer',
    };
    const attributionOverride = params.tilejson && params.tilejson.attribution;
    if (styleJSON.center && styleJSON.zoom) {
      tileJSON.center = styleJSON.center.concat(Math.round(styleJSON.zoom));
    }
    Object.assign(tileJSON, params.tilejson || {});
    tileJSON.tiles = params.domains || options.domains;
    fixTileJSONCenter(tileJSON);

    const repoobj = {
      tileJSON,
      publicUrl,
      map,
      dataProjWGStoInternalWGS: null,
      lastModified: new Date().toUTCString(),
      watermark: params.watermark || options.watermark,
      staticAttributionText:
        params.staticAttributionText || options.staticAttributionText,
    };
    repo[id] = repoobj;

    const queue = [];
    for (const name of Object.keys(styleJSON.sources)) {
      let source_type;
      let source = styleJSON.sources[name];
      let url = source.url;
      if (
        url &&
        (url.startsWith('pmtiles://') || url.startsWith('mbtiles://'))
      ) {
        // found pmtiles or mbtiles source, replace with info from local file
        delete source.url;

        let dataId = url.replace('pmtiles://', '').replace('mbtiles://', '');
        if (dataId.startsWith('{') && dataId.endsWith('}')) {
          dataId = dataId.slice(1, -1);
        }

        const mapsTo = (params.mapping || {})[dataId];
        if (mapsTo) {
          dataId = mapsTo;
        }

        let inputFile;
        const DataInfo = dataResolver(dataId);
        if (DataInfo.inputfile) {
          inputFile = DataInfo.inputfile;
          source_type = DataInfo.filetype;
        } else {
          console.error(`ERROR: data "${inputFile}" not found!`);
          process.exit(1);
        }

        if (!isValidHttpUrl(inputFile)) {
          const inputFileStats = fs.statSync(inputFile);
          if (!inputFileStats.isFile() || inputFileStats.size === 0) {
            throw Error(`Not valid PMTiles file: "${inputFile}"`);
          }
        }

        if (source_type === 'pmtiles') {
          map.sources[name] = PMtilesOpen(inputFile);
          map.source_types[name] = 'pmtiles';
          const metadata = await GetPMtilesInfo(map.sources[name]);

          if (!repoobj.dataProjWGStoInternalWGS && metadata.proj4) {
            // how to do this for multiple sources with different proj4 defs?
            const to3857 = proj4('EPSG:3857');
            const toDataProj = proj4(metadata.proj4);
            repoobj.dataProjWGStoInternalWGS = (xy) =>
              to3857.inverse(toDataProj.forward(xy));
          }

          const type = source.type;
          Object.assign(source, metadata);
          source.type = type;
          source.tiles = [
            // meta url which will be detected when requested
            `pmtiles://${name}/{z}/{x}/{y}.${metadata.format || 'pbf'}`,
          ];
          delete source.scheme;

          if (
            !attributionOverride &&
            source.attribution &&
            source.attribution.length > 0
          ) {
            if (!tileJSON.attribution.includes(source.attribution)) {
              if (tileJSON.attribution.length > 0) {
                tileJSON.attribution += ' | ';
              }
              tileJSON.attribution += source.attribution;
            }
          }
        } else {
          queue.push(
            new Promise((resolve, reject) => {
              inputFile = path.resolve(options.paths.mbtiles, inputFile);
              const inputFileStats = fs.statSync(inputFile);
              if (!inputFileStats.isFile() || inputFileStats.size === 0) {
                throw Error(`Not valid MBTiles file: "${inputFile}"`);
              }
              map.sources[name] = new MBTiles(inputFile + '?mode=ro', (err) => {
                map.sources[name].getInfo((err, info) => {
                  if (err) {
                    console.error(err);
                    return;
                  }
                  map.source_types[name] = 'mbtiles';

                  if (!repoobj.dataProjWGStoInternalWGS && info.proj4) {
                    // how to do this for multiple sources with different proj4 defs?
                    const to3857 = proj4('EPSG:3857');
                    const toDataProj = proj4(info.proj4);
                    repoobj.dataProjWGStoInternalWGS = (xy) =>
                      to3857.inverse(toDataProj.forward(xy));
                  }

                  const type = source.type;
                  Object.assign(source, info);
                  source.type = type;
                  source.tiles = [
                    // meta url which will be detected when requested
                    `mbtiles://${name}/{z}/{x}/{y}.${info.format || 'pbf'}`,
                  ];
                  delete source.scheme;

                  if (options.dataDecoratorFunc) {
                    source = options.dataDecoratorFunc(
                      name,
                      'tilejson',
                      source,
                    );
                  }

                  if (
                    !attributionOverride &&
                    source.attribution &&
                    source.attribution.length > 0
                  ) {
                    if (!tileJSON.attribution.includes(source.attribution)) {
                      if (tileJSON.attribution.length > 0) {
                        tileJSON.attribution += ' | ';
                      }
                      tileJSON.attribution += source.attribution;
                    }
                  }
                  resolve();
                });
              });
            }),
          );
        }
      }
    }

    const renderersReadyPromise = Promise.all(queue).then(() => {
      // standard and @2x tiles are much more usual -> default to larger pools
      const minPoolSizes = options.minRendererPoolSizes || [8, 4, 2];
      const maxPoolSizes = options.maxRendererPoolSizes || [16, 8, 4];
      for (let s = 1; s <= maxScaleFactor; s++) {
        const i = Math.min(minPoolSizes.length - 1, s - 1);
        const j = Math.min(maxPoolSizes.length - 1, s - 1);
        const minPoolSize = minPoolSizes[i];
        const maxPoolSize = Math.max(minPoolSize, maxPoolSizes[j]);
        map.renderers[s] = createPool(s, 'tile', minPoolSize, maxPoolSize);
        map.renderers_static[s] = createPool(
          s,
          'static',
          minPoolSize,
          maxPoolSize,
        );
      }
    });

    return Promise.all([renderersReadyPromise]);
  },
  remove: (repo, id) => {
    const item = repo[id];
    if (item) {
      item.map.renderers.forEach((pool) => {
        pool.close();
      });
      item.map.renderers_static.forEach((pool) => {
        pool.close();
      });
    }
    delete repo[id];
  },
};
