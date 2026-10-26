// Minimal service worker: gives the extension a runtime target (useful for
// debugging in chrome://extensions) and keeps the manifest a normal MV3 one.
chrome.runtime.onInstalled.addListener(() => {
  console.log('ego-browser login bridge installed')
})
