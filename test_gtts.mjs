import gtts from 'google-tts-api';
gtts.getAudioUrl('Bonjour', { lang: 'fr', slow: false, host: 'https://translate.google.com' })
  .then(url => console.log(' Audio URL OK:', url.substring(0, 80)))
  .catch(err => console.error(' Error:', err.message));
