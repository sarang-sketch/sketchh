// Settings for the Sketch website. This is the only file you need to edit.
window.SKETCH_SITE = {
  // The GitHub repository, as owner/name. Every GitHub link on the page is built from it.
  repo: 'sarang-sketch/sketch',

  // Where "Download the beta for Windows" points. Leave empty to use GitHub Releases:
  // the page links straight to the newest release's .exe when there is one (see the
  // next setting), and to the repository's releases page otherwise.
  downloadUrl: '',

  // Ask the GitHub API for the newest releases when the page loads, so the download
  // button can link straight to the installer and show its real size. This is one
  // request from the visitor's browser to api.github.com. Set to false to skip it.
  checkLatestRelease: true,

  // An HTTPS address that accepts a POST of {"email": "...", "source": "sketch-website"}
  // as JSON (for example a Formspree form, a Cloudflare Worker or a Google Apps Script).
  // While this is empty, the "email me when Sketch launches" form stays hidden.
  launchEmailEndpoint: '',
}
