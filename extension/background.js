import { LibraryController } from './library-controller.mjs';
const controller = new LibraryController(chrome);
chrome.action.onClicked.addListener(() => { controller.openLibrary().catch(() => {}); });
chrome.runtime.onMessage.addListener((message,sender,respond) => {
  controller.handle(message,sender).then(respond).catch(() => respond({ok:false,message:'Echo Companion could not complete this request.'}));
  return true;
});
