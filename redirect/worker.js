// Sends wonkolingo.com to the live site on workers.dev. A temporary (302) redirect, so the domain can later serve the
// app itself without browsers having cached a permanent redirect.
const SITE = 'https://wonkolingo.alex-l-lintz.workers.dev';
export default {
  fetch(req) {
    const url = new URL(req.url);
    return Response.redirect(SITE + url.pathname + url.search, 302);
  }
};
