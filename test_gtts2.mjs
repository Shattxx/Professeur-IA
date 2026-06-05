import gtts from 'google-tts-api';
const result = gtts.getAudioUrl('Bonjour', { lang: 'fr' });
console.log('Type:', typeof result);
console.log('Is Promise:', result instanceof Promise);
console.log('Value:', String(result).substring(0, 100));
if (result instanceof Promise) {
  result.then(url => console.log('Promise resolved:', String(url).substring(0, 80)))
    .catch(e => console.error('Promise error:', e.message));
}
