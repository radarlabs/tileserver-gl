'use strict';

import path from 'path';
import fs from 'node:fs';
import clone from 'clone';
import sharp from 'sharp';
import glyphCompose from '@mapbox/glyph-pbf-composite';

/**
 * Generate new URL object
 * @param req
 * @params {object} req - Express request
 * @returns {URL} object
 */
const getUrlObject = (req) => {
  const urlObject = new URL(`${req.protocol}://${req.headers.host}/`);
  // support overriding hostname by sending X-Forwarded-Host http header
  urlObject.hostname = req.hostname;
  return urlObject;
};

export const getPublicUrl = (publicUrl, req) => {
  if (publicUrl) {
    return publicUrl;
  }
  return getUrlObject(req).toString();
};

export const getTileUrls = (req, domains, path, format, publicUrl, aliases) => {
  const urlObject = getUrlObject(req);
  if (domains) {
    if (domains.constructor === String && domains.length > 0) {
      domains = domains.split(',');
    }
    const hostParts = urlObject.host.split('.');
    const relativeSubdomainsUsable =
      hostParts.length > 1 &&
      !/^([0-9]{1,3}\.){3}[0-9]{1,3}(\:[0-9]+)?$/.test(urlObject.host);
    const newDomains = [];
    for (const domain of domains) {
      if (domain.indexOf('*') !== -1) {
        if (relativeSubdomainsUsable) {
          const newParts = hostParts.slice(1);
          newParts.unshift(domain.replace('*', hostParts[0]));
          newDomains.push(newParts.join('.'));
        }
      } else {
        newDomains.push(domain);
      }
    }
    domains = newDomains;
  }
  if (!domains || domains.length == 0) {
    domains = [urlObject.host];
  }

  const queryParams = [];
  if (req.query.key) {
    queryParams.push(`key=${encodeURIComponent(req.query.key)}`);
  }
  if (req.query.style) {
    queryParams.push(`style=${encodeURIComponent(req.query.style)}`);
  }
  const query = queryParams.length > 0 ? `?${queryParams.join('&')}` : '';

  if (aliases && aliases[format]) {
    format = aliases[format];
  }

  const uris = [];
  if (!publicUrl) {
    for (const domain of domains) {
      uris.push(
        `${req.protocol}://${domain}/${path}/{z}/{x}/{y}.${format}${query}`,
      );
    }
  } else {
    uris.push(`${publicUrl}${path}/{z}/{x}/{y}.${format}${query}`);
  }

  return uris;
};

export const fixTileJSONCenter = (tileJSON) => {
  if (tileJSON.bounds && !tileJSON.center) {
    const fitWidth = 1024;
    const tiles = fitWidth / 256;
    tileJSON.center = [
      (tileJSON.bounds[0] + tileJSON.bounds[2]) / 2,
      (tileJSON.bounds[1] + tileJSON.bounds[3]) / 2,
      Math.round(
        -Math.log((tileJSON.bounds[2] - tileJSON.bounds[0]) / 360 / tiles) /
          Math.LN2,
      ),
    ];
  }
};

const getFontPbf = (allowedFonts, fontPath, name, range, fallbacks) =>
  new Promise((resolve, reject) => {
    if (!allowedFonts || (allowedFonts[name] && fallbacks)) {
      const filename = path.join(fontPath, name, `${range}.pbf`);
      if (!fallbacks) {
        fallbacks = clone(allowedFonts || {});
      }
      delete fallbacks[name];
      fs.readFile(filename, (err, data) => {
        if (err) {
          console.error(`ERROR: Font not found: ${name}`);
          if (fallbacks && Object.keys(fallbacks).length) {
            let fallbackName;

            let fontStyle = name.split(' ').pop();
            if (['Regular', 'Bold', 'Italic'].indexOf(fontStyle) < 0) {
              fontStyle = 'Regular';
            }
            fallbackName = `Noto Sans ${fontStyle}`;
            if (!fallbacks[fallbackName]) {
              fallbackName = `Open Sans ${fontStyle}`;
              if (!fallbacks[fallbackName]) {
                fallbackName = Object.keys(fallbacks)[0];
              }
            }

            console.error(`ERROR: Trying to use ${fallbackName} as a fallback`);
            delete fallbacks[fallbackName];
            getFontPbf(null, fontPath, fallbackName, range, fallbacks).then(
              resolve,
              reject,
            );
          } else {
            reject(`Font load error: ${name}`);
          }
        } else {
          resolve(data);
        }
      });
    } else {
      reject(`Font not allowed: ${name}`);
    }
  });

export const getFontsPbf = (
  allowedFonts,
  fontPath,
  names,
  range,
  fallbacks,
) => {
  const fonts = names.split(',');
  const queue = [];
  for (const font of fonts) {
    queue.push(
      getFontPbf(
        allowedFonts,
        fontPath,
        font,
        range,
        clone(allowedFonts || fallbacks),
      ),
    );
  }

  return Promise.all(queue).then((values) => glyphCompose.combine(values));
};

export const isValidHttpUrl = (string) => {
  let url;

  try {
    url = new URL(string);
  } catch (_) {
    return false;
  }

  return url.protocol === 'http:' || url.protocol === 'https:';
};

// generate base64 data url for default marker
export const generateMarker = async (scale = 1, color = '#000257') => {
  const markerSVG = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="30" height="45" fill="none">
      <defs>
        <path id="reuse-0" fill="#000" d="M15 44.4c-6.44 0-11.67-2.6-11.67-5.82 0-3.21 5.23-5.82 11.67-5.82 6.44 0 11.67 2.6 11.67 5.82S21.44 44.4 15 44.4Z" opacity=".04"/>
      </defs>
      <use xlink:href="#reuse-0" opacity=".04"/>
      <use xlink:href="#reuse-0" opacity=".04"/>
      <path fill="#000" d="M15 43.87c-5.83 0-10.56-2.37-10.56-5.29S9.17 33.3 15 33.3s10.56 2.37 10.56 5.3c0 2.91-4.73 5.28-10.56 5.28Z" opacity=".04"/>
      <path fill="#000" d="M15 43.34c-5.22 0-9.44-2.13-9.44-4.76s4.22-4.76 9.44-4.76 9.44 2.13 9.44 4.76-4.22 4.76-9.44 4.76Z" opacity=".04"/>
      <path fill="#000" d="M15 42.81c-4.6 0-8.33-1.9-8.33-4.23 0-2.34 3.73-4.23 8.33-4.23s8.33 1.9 8.33 4.23c0 2.34-3.73 4.23-8.33 4.23Z" opacity=".04"/>
      <path fill="#000" d="M15 42.29c-3.99 0-7.22-1.66-7.22-3.7 0-2.05 3.23-3.71 7.22-3.71 3.99 0 7.22 1.66 7.22 3.7 0 2.05-3.23 3.7-7.22 3.7Z" opacity=".04"/>
      <path fill="#000" d="M15 41.76c-3.38 0-6.11-1.43-6.11-3.18 0-1.75 2.73-3.17 6.11-3.17 3.38 0 6.11 1.42 6.11 3.17s-2.73 3.18-6.11 3.18Z" opacity=".04"/>
      <path fill="#000" d="M15 41.23c-2.76 0-5-1.19-5-2.65s2.24-2.64 5-2.64 5 1.18 5 2.64c0 1.46-2.24 2.65-5 2.65Z" opacity=".04"/>
      <path fill="${color}" d="M0 14.97c0 6.18 7.5 14.96 13.61 23.28.82 1.1 1.96 1.1 2.78 0C22.5 29.93 30 21.3 30 14.97 30 6.7 23.28 0 15 0 6.72 0 0 6.7 0 14.97Z"/>
      <path fill="#000" d="M15 0c8.28 0 15 6.7 15 14.97 0 6.34-7.5 14.96-13.61 23.28-.83 1.13-1.96 1.1-2.78 0C7.5 29.93 0 21.15 0 14.97 0 6.7 6.72 0 15 0Zm0 1.1C7.32 1.1 1.11 7.3 1.11 14.98c0 2.66 1.67 6.3 4.2 10.24 2.53 3.94 6.13 8.2 9.2 12.38.22.3.36.46.49.6.13-.14.27-.3.5-.6 3.07-4.19 6.26-8.42 8.93-12.34 2.66-3.93 4.46-7.56 4.46-10.28C28.89 7.3 22.69 1.1 15 1.1Z" opacity=".25"/>
      <path fill="#000" d="M15 21.06a6.1 6.1 0 1 1-.01-12.2 6.1 6.1 0 0 1 .01 12.2Z" opacity=".25"/>
      <path fill="#fff" d="M15 21.06a6.1 6.1 0 1 1-.01-12.2 6.1 6.1 0 0 1 .01 12.2Z"/>
    </svg>`;

  let markerBuffer = Buffer.from(markerSVG);
  if (scale > 1) {
    markerBuffer = await sharp(markerBuffer)
      .resize(30 * scale, 45 * scale)
      .toBuffer();
  }

  const pngBuffer = await sharp(markerBuffer).png().toBuffer();

  return `data:image/png;base64,${pngBuffer.toString('base64')}`;
};
