(() => {
  'use strict';
  const runtime = message => new Promise((resolve,reject) => {
    chrome.runtime.sendMessage(message, result => {
      if (chrome.runtime.lastError) return reject(new Error('The extension was updated. Reload this music library page.'));
      if (!result?.ok) return reject(new Error(result?.message || 'The local helper could not complete this request.'));
      resolve(result);
    });
  });
  window.echoExtensionFetch = async (path, options = {}) => {
    const method = options.method || 'GET';
    if (options.signal?.aborted) throw new DOMException('Request cancelled.','AbortError');
    let body;
    if (options.body !== undefined) { try { body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body; } catch { throw new Error('Invalid request data.'); } }
    const request = runtime({type:'LIBRARY_REQUEST',path,method,...(body === undefined ? {} : {body})});
    let cancel;
    const aborted = new Promise((_,reject) => { cancel = () => reject(new DOMException('Request cancelled.','AbortError')); options.signal?.addEventListener('abort',cancel,{once:true}); });
    try {
      const {response} = await Promise.race([request,aborted]);
      return {ok:response.ok,status:response.status,json:async()=>response.data};
    } finally { options.signal?.removeEventListener('abort',cancel); }
  };
})();
