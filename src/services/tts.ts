

import { AppSettings } from '../constants';

let currentAudio: HTMLAudioElement | null = null;
let currentUtterance: SpeechSynthesisUtterance | null = null;
let speechQueue: { text: string; settings?: AppSettings }[] = [];
let isProcessingQueue = false;

export async function speak(text: string, settings?: AppSettings): Promise<void> {
  const cleanText = text.replace(/[*#_`]/g, "").trim();
  if (!cleanText) return;

  speechQueue.push({ text: cleanText, settings });
  
  if (!isProcessingQueue) {
    processQueue();
  }
}

async function processQueue() {
  if (speechQueue.length === 0) {
    isProcessingQueue = false;
    return;
  }

  isProcessingQueue = true;
  const item = speechQueue.shift()!;

  try {
    if (item.settings?.ttsProvider === 'google') {
      await speakWithGoogle(item.text);
    } else {
      await speakWithBrowser(item.text);
    }
  } catch (error) {
    console.error("Error in processQueue:", error);
  }

  // Process next item in queue
  processQueue();
}

export function stopAllSpeech() {
  // Clear queue
  speechQueue = [];
  isProcessingQueue = false;

  // Stop Browser TTS
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  currentUtterance = null;

  // Stop Audio (if any other audio is playing)
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
}

async function speakWithGoogle(text: string): Promise<void> {
  return new Promise(async (resolve) => {
    try {
      const audio = new Audio();
      currentAudio = audio;
      const lang = "fr"; // French language
      
      // Fetch the audio with lang parameter
      const response = await fetch(`/api/tts?text=${encodeURIComponent(text)}&lang=${encodeURIComponent(lang)}`);
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
        console.error("Google TTS Server Error:", errorData);
        console.log("Falling back to Browser TTS...");
        await speakWithBrowser(text);
        resolve();
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      audio.src = url;
      
      audio.onended = () => {
        URL.revokeObjectURL(url);
        currentAudio = null;
        resolve();
      };
      
      audio.onerror = async (e) => {
        console.error("Google TTS playback error:", e);
        URL.revokeObjectURL(url);
        currentAudio = null;
        console.log("Falling back to Browser TTS...");
        await speakWithBrowser(text);
        resolve();
      };
      
      audio.play().catch(async err => {
        console.error("Audio play failed:", err);
        URL.revokeObjectURL(url);
        currentAudio = null;
        console.log("Falling back to Browser TTS...");
        await speakWithBrowser(text);
        resolve();
      });
    } catch (err) {
      console.error("speakWithGoogle failed:", err);
      console.log("Falling back to Browser TTS...");
      await speakWithBrowser(text);
      resolve();
    }
  });
}

async function speakWithBrowser(text: string): Promise<void> {
  const getFrenchVoice = () => {
    const voices = window.speechSynthesis.getVoices();
    // Prioritize high quality French voices if available
    const frVoices = voices.filter(v => v.lang.startsWith('fr'));
    return frVoices.find(v => v.name.includes('Google')) || frVoices[0] || voices.find(v => v.lang.startsWith('en')) || voices[0];
  };

  return new Promise((resolve) => {
    const startSpeaking = () => {
      // If text is too long, browser TTS might hang. 
      // But we are already splitting by sentences in App.tsx, so it should be fine.
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'fr-FR';
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      
      const voice = getFrenchVoice();
      if (voice) {
        utterance.voice = voice;
      }

      utterance.onend = () => {
        currentUtterance = null;
        resolve();
      };
      
      utterance.onerror = (e) => {
        if (e.error !== 'interrupted') {
          console.error("Browser TTS error:", e);
        }
        currentUtterance = null;
        resolve();
      };

      currentUtterance = utterance;
      window.speechSynthesis.speak(utterance);
    };

    if (window.speechSynthesis.getVoices().length === 0) {
      window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.onvoiceschanged = null;
        startSpeaking();
      };
    } else {
      startSpeaking();
    }
  });
}

export function isSpeaking(): boolean {
  const isBrowserSpeaking = typeof window !== 'undefined' && window.speechSynthesis ? window.speechSynthesis.speaking : false;
  return isBrowserSpeaking || !!currentAudio || isProcessingQueue || speechQueue.length > 0;
}
