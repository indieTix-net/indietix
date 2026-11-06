// CloudFront Function (viewer-request, cloudfront-js-2.0) for venues' own
// web addresses (QRScanner's VENUE WEB ADDRESS). On <name>.<domain>, the
// plain /privacy.html and /terms.html serve that venue's own pages from
// venue-sites/<name>/, which QRScanner renders from its LEGAL_* settings,
// so a venue's 10DLC campaign can register its own plain URLs.
// Every other host passes through untouched, including the distribution's
// own *.cloudfront.net address (Liberty Hall's campaign registers its pages
// there). Attach it only to the /privacy.html and /terms.html cache
// behaviors. Replace the domain below with the deployment's
// VENUE_SITE_DOMAIN when creating the function.
var VENUE_SITE_DOMAIN = '.indietix.net';
var NAME = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri !== '/privacy.html' && uri !== '/terms.html') return request;
  var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
  if (host.length <= VENUE_SITE_DOMAIN.length || host.slice(-VENUE_SITE_DOMAIN.length) !== VENUE_SITE_DOMAIN) return request;
  var name = host.slice(0, host.length - VENUE_SITE_DOMAIN.length);
  if (!NAME.test(name) || name.indexOf('--') !== -1) return request;
  request.uri = '/venue-sites/' + name + uri;
  return request;
}
