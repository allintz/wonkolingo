// Serve the app at the name-free domain through an internal service connection.
export default {
  fetch(req, env) {
    const url = new URL(req.url);
    if (url.hostname === 'www.wonkolingo.com') {
      url.hostname = 'wonkolingo.com';
      return Response.redirect(url.href, 308);
    }
    return env.WONKOLINGO.fetch(req);
  }
};
