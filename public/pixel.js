// Meta Pixel. It loads only when Panel → Ajustes → Publicidad has a pixel id; otherwise nothing is sent to Meta.
// Events: PageView, ViewContent (raffle shown), InitiateCheckout (checkout opened), Lead (tickets reserved), Purchase (receipt sent).
(()=>{const waiting=[];window.pesoTrack=(event,params)=>{waiting.push([event,params]);};
fetch('/api/site-config').then(r=>r.ok?r.json():{}).then(config=>{const id=String(config.pixel||'');if(!/^\d{10,20}$/.test(id)){window.pesoTrack=()=>{};return;}
const fbq=function(){if(fbq.callMethod)fbq.callMethod.apply(fbq,arguments);else fbq.queue.push(arguments);};fbq.push=fbq;fbq.loaded=true;fbq.version='2.0';fbq.queue=[];window.fbq=fbq;if(!window._fbq)window._fbq=fbq;
const script=document.createElement('script');script.async=true;script.src='https://connect.facebook.net/en_US/fbevents.js';document.head.append(script);
fbq('init',id);fbq('track','PageView');window.pesoTrack=(event,params)=>fbq('track',event,params);for(const [event,params] of waiting.splice(0))fbq('track',event,params);}).catch(()=>{window.pesoTrack=()=>{};});})();
