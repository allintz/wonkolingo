// The app moved from hill-speak.* to wonkolingo.*; send every old link (and API call) to the same path there.
export default {
  fetch(req) {
    const url = new URL(req.url);
    url.hostname = 'wonkolingo.alex-l-lintz.workers.dev';
    return Response.redirect(url.toString(), 308);
  }
};
