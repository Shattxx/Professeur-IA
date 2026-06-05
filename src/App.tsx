/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import * as math from 'mathjs';
import { 
  Send, 
  BookOpen, 
  Volume2, 
  VolumeX,
  User, 
  Bot, 
  Loader2, 
  Sparkles,
  Search,
  Settings as SettingsIcon,
  X,
  Save,
  FileText,
  Globe,
  Trash2,
  Download,
  Folder,
  FolderOpen,
  ArrowUp,
  RefreshCw,
  Plus,
  GraduationCap,
  Play,
  BarChart3,
  History,
  CheckCircle2,
  AlertCircle,
  Zap,
  Cpu,
  MessageSquarePlus,
  Camera,
  Image as ImageIcon,
  Square,
  XCircle
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { chatWithAI, analyzeImageWithLlama, Message } from './services/ai';
import { cn } from './lib/utils';
import { AppSettings, DEFAULT_SETTINGS } from './constants';
import { speak as ttsSpeak, stopAllSpeech, isSpeaking as isAnySpeaking } from './services/tts';
import { Avatar } from './components/Avatar';
import { PDFAnnotationViewer } from './components/PDFAnnotationViewer';

const getFolderName = (fullPath: string) => {
  if (!fullPath) return "";
  const normalized = fullPath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts.filter(Boolean).pop() || normalized;
};

interface ExamResult {
  id: string;
  date: string;
  subject: string;
  score: number;
  total: number;
  feedback: string;
}

interface QuizQuestion {
  question: string;
  options: string[];
  answer: number | string;
  explanation: string;
}

interface QuizData {
  theme: string;
  questions: QuizQuestion[];
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [ragSearchStatus, setRagSearchStatus] = useState<'idle' | 'searching' | 'found' | 'none_found' | 'generating'>('idle');
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem('prof_ia_settings');
    if (saved) {
      try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
      } catch (e) {
        return DEFAULT_SETTINGS;
      }
    }
    return DEFAULT_SETTINGS;
  });
  const [localModels, setLocalModels] = useState<any[]>([]);
  const [newModelName, setNewModelName] = useState('');
  const [isPulling, setIsPulling] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [isPurging, setIsPurging] = useState(false);
  const [indexStatus, setIndexStatus] = useState<{count: number} | null>(null);
  const [indexingProgress, setIndexingProgress] = useState<{
    total: number;
    current: number;
    fileName: string;
    status: 'listing' | 'indexing' | 'completed' | 'error' | 'stopped';
  } | null>(null);
  const stopIndexingRef = useRef(false);
  const [isExamMode, setIsExamMode] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [examResults, setExamResults] = useState<ExamResult[]>([]);
  const [isEngineConnected, setIsEngineConnected] = useState(true);
  const [isStatusInitialized, setIsStatusInitialized] = useState(false);
  const autoStartEmbeddingDoneRef = useRef(false);
  const lastAutoStartedModelRef = useRef<string | null>(null);
  const [showToolWarning, setShowToolWarning] = useState(false);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Quiz State
  const [showQuizModal, setShowQuizModal] = useState(false);
  const [quizTheme, setQuizTheme] = useState('');
  const [quizState, setQuizState] = useState<'setup' | 'loading' | 'playing' | 'finished'>('setup');
  const [quizData, setQuizData] = useState<QuizData | null>(null);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [isAnswerChecked, setIsAnswerChecked] = useState(false);
  const [quizScore, setQuizScore] = useState(0);
  const [quizQuestionCount, setQuizQuestionCount] = useState(10);

  // Image Analysis State
  const [showImageModal, setShowImageModal] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeProgress, setScrapeProgress] = useState<any>(null);
  const [newUrl, setNewUrl] = useState("");
  const [availableDocs, setAvailableDocs] = useState<{name: string, path: string}[]>([]);
  const [showDocSelector, setShowDocSelector] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<{name: string, path: string} | null>(null);

  // Folder Browser States
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [folderBrowserPath, setFolderBrowserPath] = useState('');
  const [folderBrowserDirectories, setFolderBrowserDirectories] = useState<{name: string, path: string}[]>([]);
  const [folderBrowserParentPath, setFolderBrowserParentPath] = useState<string | null>(null);
  const [folderBrowserError, setFolderBrowserError] = useState<string | null>(null);

  const browseFolder = async (pathStr?: string) => {
    try {
      setFolderBrowserError(null);
      const url = `/api/fs/browse` + (pathStr ? `?folderPath=${encodeURIComponent(pathStr)}` : '');
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setFolderBrowserPath(data.currentPath);
        setFolderBrowserDirectories(data.directories || []);
        setFolderBrowserParentPath(data.parentPath);
      } else {
        const errData = await res.json().catch(() => null);
        setFolderBrowserError(errData?.error || "Erreur de lecture du dossier");
      }
    } catch (e: any) {
      setFolderBrowserError(e.message || "Erreur de connexion");
    }
  };

  // Llama.cpp States & Updaters
  const [llamaStatus, setLlamaStatus] = useState<any>({
    running: false,
    modelPath: "",
    acceleration: "vulkan",
    binaries: { cpu: false, vulkan: false, cuda: false },
    logs: [],
    downloadProgress: { status: "idle", progress: 0 },
    modelDownloadProgress: { status: "idle", progress: 0 }
  });
  const [ggufModels, setGgufModels] = useState<any[]>([]);
  const [hfModelUrl, setHfModelUrl] = useState("https://huggingface.co/AhmedxSaad/Qwen3-VL-Embedding-2B-Q4_K_M-GGUF/resolve/main/qwen3-vl-embedding-2b-q4_k_m.gguf");
  const [latestBinaryTag, setLatestBinaryTag] = useState("b9382");
  const [dbStatus, setDbStatus] = useState<{ connected: boolean; tables: { name: string; count: number }[] } | null>(null);

  const fetchDbStatus = async () => {
    try {
      const res = await fetch("/api/db/status");
      if (res.ok) {
        const data = await res.json();
        setDbStatus(data);
      }
    } catch(e) {}
  };

  const fetchLlamaStatus = async () => {
    try {
      const res = await fetch("/api/llama/status");
      if (res.ok) {
        const data = await res.json();
        setLlamaStatus(data);
        setIsEngineConnected(data.running);
        setIsStatusInitialized(true);
      }
    } catch(e) {
      setIsEngineConnected(false);
    }
  };

  const fetchGgufModels = async () => {
    try {
      const res = await fetch("/api/llama/models/list");
      if (res.ok) {
        const data = await res.json();
        setGgufModels(data.models || []);
      }
    } catch(e) {
      console.error("Failed to fetch GGUF list:", e);
    }
  };

  const checkBinaryUpdates = async () => {
    try {
      const res = await fetch("/api/llama/check-updates");
      if (res.ok) {
        const data = await res.json();
        setLatestBinaryTag(data.latestTag || "b9382");
      }
    } catch(e) {}
  };

  const downloadBinary = async (type: 'cpu' | 'vulkan' | 'cuda') => {
    try {
      await fetch("/api/llama/binaries/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: latestBinaryTag, type })
      });
      fetchLlamaStatus();
    } catch(e) {}
  };

  const downloadAllBinaries = async () => {
    try {
      await fetch("/api/llama/binaries/download-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: latestBinaryTag })
      });
      fetchLlamaStatus();
    } catch(e) {}
  };

  const downloadModel = async () => {
    if (!hfModelUrl.trim()) return;
    try {
      await fetch("/api/llama/models/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: hfModelUrl })
      });
      fetchLlamaStatus();
    } catch(e) {}
  };

  const deleteGgufModel = async (name: string) => {
    if (!confirm(`Supprimer le fichier GGUF ${name} ?`)) return;
    try {
      await fetch("/api/llama/models/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      fetchGgufModels();
    } catch(e) {}
  };

  const startLlamaServer = async (modelPath: string) => {
    try {
      await fetch("/api/llama/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelPath,
          acceleration: settings.acceleration,
          flashAttn: settings.useFlashAttention
        })
      });
      fetchLlamaStatus();
    } catch(e) {}
  };

  const stopLlamaServer = async () => {
    try {
      await fetch("/api/llama/stop", { method: "POST" });
      fetchLlamaStatus();
    } catch(e) {}
  };

  const startLlamaEmbeddingServer = async (modelPath: string) => {
    try {
      await fetch("/api/llama/start-embedding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelPath,
          acceleration: settings.acceleration,
          flashAttn: settings.useFlashAttention
        })
      });
      fetchLlamaStatus();
    } catch(e) {}
  };

  const stopLlamaEmbeddingServer = async () => {
    try {
      await fetch("/api/llama/stop-embedding", { method: "POST" });
      fetchLlamaStatus();
    } catch(e) {}
  };

  useEffect(() => {
    fetchLlamaStatus();
    checkBinaryUpdates();
    fetchGgufModels();
    fetchDbStatus();
    
    const interval = setInterval(() => {
      fetchLlamaStatus();
      fetchDbStatus();
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let interval: any;
    if (showSettings) {
      fetchLlamaStatus();
      fetchGgufModels();
      checkBinaryUpdates();
      fetchDbStatus();
      interval = setInterval(() => {
        fetchLlamaStatus();
        fetchGgufModels();
        fetchDbStatus();
      }, 1500);
    }
    return () => clearInterval(interval);
  }, [showSettings]);

  useEffect(() => {
    localStorage.setItem('prof_ia_settings', JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (isStatusInitialized && !autoStartEmbeddingDoneRef.current) {
      autoStartEmbeddingDoneRef.current = true;
      if (!llamaStatus.embeddingRunning) {
        console.log("[Embedding AutoStart] Automatically launching CPU embedding model on application open:", settings.embeddingModelPath || "default");
        startLlamaEmbeddingServer(settings.embeddingModelPath || "");
      }
    }
  }, [isStatusInitialized, settings.embeddingModelPath, llamaStatus.embeddingRunning]);

  useEffect(() => {
    if (isStatusInitialized && settings.selectedModelPath) {
      const isDifferent = !llamaStatus.running || llamaStatus.modelPath !== settings.selectedModelPath;
      if (isDifferent && lastAutoStartedModelRef.current !== settings.selectedModelPath) {
        lastAutoStartedModelRef.current = settings.selectedModelPath;
        console.log("[LLM AutoStart] Automatically starting LLM server with model:", settings.selectedModelPath);
        startLlamaServer(settings.selectedModelPath);
      }
    }
  }, [isStatusInitialized, settings.selectedModelPath, llamaStatus.running, llamaStatus.modelPath]);

  useEffect(() => {
    let interval: any;
    if (isScraping) {
      interval = setInterval(async () => {
        try {
          const resp = await fetch('/api/scrape/progress');
          const data = await resp.json();
          setScrapeProgress(data);
          if (data.status === 'completed' || data.status === 'error') {
            setIsScraping(false);
          }
        } catch (e) {
          console.error("Failed to poll progress:", e);
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isScraping]);

  const startScraping = async () => {
    if (settings.urlsToScrape.length === 0) return;
    setIsScraping(true);
    setScrapeProgress({ status: 'starting', progress: 0 });
    try {
      const resp = await fetch('/api/scrape/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: settings.urlsToScrape, settings })
      });
      if (!resp.ok) throw new Error("Failed to start scraping");
    } catch (e: any) {
      setIsScraping(false);
      alert(e.message);
    }
  };

  const addUrl = () => {
    if (!newUrl.trim()) return;
    try {
      new URL(newUrl);
      if (!settings.urlsToScrape.includes(newUrl)) {
        setSettings({ ...settings, urlsToScrape: [...settings.urlsToScrape, newUrl] });
      }
      setNewUrl("");
    } catch (e) {
      alert("URL invalide");
    }
  };

  const removeUrl = (url: string) => {
    setSettings({ ...settings, urlsToScrape: settings.urlsToScrape.filter(u => u !== url) });
  };

  useEffect(() => {
    const savedResults = localStorage.getItem('prof_ia_results');
    if (savedResults) {
      setExamResults(JSON.parse(savedResults));
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('prof_ia_results', JSON.stringify(examResults));
  }, [examResults]);

  useEffect(() => {
    if (showSettings) {
      fetchModels();
    }
  }, [showSettings, settings.llamaIp, settings.llamaPort]);

  useEffect(() => {
    const checkHealth = async () => {
      try {
        const res = await fetch('/api/health');
        if (res.ok) {
          console.log("Server health check OK");
        } else {
          console.error("Server health check failed", res.status);
        }
      } catch (e) {
        console.error("Server unreachable", e);
      }
    };
    checkHealth();
  }, []);

  const generateQuiz = async () => {
    if (!quizTheme.trim()) return;
    setQuizState('loading');
    
    const prompt = `Tu es un expert pédagogique. Génère un quiz à choix multiples (QCM) de ${quizQuestionCount} questions de haute qualité sur le thème suivant : "${quizTheme}".

Instructions de qualité et de conception de QCM strictes :
- AUCUNE RÉPÉTITION DE QUESTION : Chaque question doit être totalement unique, aborder un aspect différent du thème, et ne pas reformuler une autre question présente dans le même quiz. Varie au maximum les notions abordées pour couvrir le sujet de façon large.
- UNE SEULE ET UNIQUE BONNE RÉPONSE : Il doit y avoir une seule réponse possible qui soit absolument et indubitablement correcte. Aucune autre option ne doit pouvoir être interprétée comme juste ou partiellement juste.
- DISTRACTEURS RIGOUREUSEMENT FAUX : Les trois autres propositions (les distracteurs) doivent être plausibles mais ENTIÈREMENT FAUSSES face à la question. 
- PAS DE RÉPONSES TRÈS PROCHES OU AMBIGUËS : Ne crée pas de choix trop subtils où la différence entre la bonne et la mauvaise réponse repose sur une nuance d'interprétation discutable.
- AUCUN CHOIX MULTIPLE GLOBALE DE TYPE "A et B" ou "TOUTES LES RÉPONSES" : Chaque proposition doit être un énoncé autonome, clair et fausse ou vraie individuellement. Pas d'expressions comme "Aucune de ces propositions" ou "Les deux premières réponses".
- SI la question implique un calcul, tu DOIS fournir le champ "calculation" avec l'expression mathématique exacte utilisée pour trouver la réponse, pour permettre une validation automatique.
- Assure la rigueur scientifique et historique.
- L'explication doit être courte, claire et justifier pourquoi la bonne réponse est la meilleure.

Contrainte de sortie :
Tu dois OBLIGATOIREMENT répondre UNIQUEMENT avec un objet JSON valide, sans aucun texte avant ou après, ni de bloc markdown.
Format JSON attendu :
{
  "theme": "${quizTheme}",
  "questions": [
    {
      "question": "Énonce ici une question précise et bien formulée.",
      "options": ["Choix 1", "Choix 2", "Choix 3", "Choix 4"],
      "answer": 0,
      "explanation": "Explique ici, de manière rigoureuse, pourquoi cette réponse est la bonne.",
      "calculation": "Si applicable, l'expression mathématique utilisée (ex: '2 * 3 + 5'). Sinon, omet ce champ."
    }
  ]
}
IMPORTANT : La propriété "answer" doit être l'INDEX (0, 1, 2 ou 3) de la bonne réponse dans le tableau "options". Vérifie deux fois la justesse absolue de tes questions et l'invalidité totale de tes options fausses avant de répondre.`;

    try {
      const response = await chatWithAI(
        [],
        prompt,
        { ...settings, systemPrompt: "Tu es un expert pédagogique expert en création de QCM stricts en JSON. Tu garantis que chaque question est UNIQUE (aucune répétition ni doublon), contient une SEULE et UNIQUE réponse absolument vraie, et trois distracteurs plausibles mais indiscutablement et rigoureusement FAUSSES. Aucun choix multiple, flou ou ambiguïté n'est toléré. Tu ne dois répondre qu'avec un objet JSON valide conforme au schéma demandé." },
        undefined,
        undefined,
        { temperature: 0.4, disableTools: true, max_tokens: 16384 }
      );
      
      let text = response.text.trim();
      
      // Extract JSON if there's extra text
      const firstBrace = text.indexOf('{');
      const lastBrace = text.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        text = text.substring(firstBrace, lastBrace + 1);
      }
      
      let parsedQuiz: any = null;
      try {
        parsedQuiz = JSON.parse(text);
      } catch (parseError) {
        console.warn("[QCM] Direct JSON parse failed, attempting parsing of partial JSON and recovery of individual questions...", parseError);
        // Let's try to extract all individual question objects using brace matching
        const questionBlocks: any[] = [];
        
        let index = 0;
        while (true) {
          const nextBrace = text.indexOf('{', index);
          if (nextBrace === -1) break;
          
          let braceCount = 1;
          let i = nextBrace + 1;
          let inString = false;
          let escape = false;
          while (i < text.length && braceCount > 0) {
            const char = text[i];
            if (escape) {
              escape = false;
            } else if (char === '\\') {
              escape = true;
            } else if (char === '"') {
              inString = !inString;
            } else if (!inString) {
              if (char === '{') braceCount++;
              else if (char === '}') braceCount--;
            }
            i++;
          }
          
          if (braceCount === 0) {
            const blockCandidate = text.substring(nextBrace, i);
            try {
              const qObj = JSON.parse(blockCandidate);
              if (qObj && typeof qObj === 'object' && qObj.question && Array.isArray(qObj.options)) {
                questionBlocks.push(qObj);
              }
            } catch (e) {
              // Not a complete parseable single object, move on
            }
            index = i;
          } else {
            // Unmatched brace (truncated text) - try to auto-repair candidate
            const blockCandidate = text.substring(nextBrace) + "}".repeat(braceCount);
            try {
              const qObj = JSON.parse(blockCandidate);
              if (qObj && typeof qObj === 'object' && qObj.question && Array.isArray(qObj.options)) {
                questionBlocks.push(qObj);
              }
            } catch (e) {
              // Failed to repair
            }
            break;
          }
        }
        
        if (questionBlocks.length > 0) {
          parsedQuiz = {
            theme: quizTheme,
            questions: questionBlocks
          };
          console.log(`[QCM] Robust parser successfully recovered ${questionBlocks.length} questions from incomplete JSON!`);
        } else {
          // Attempt structural bracket-fixing on the whole string
          let repairedText = text;
          if (!repairedText.endsWith('}')) {
            const openBraces = (repairedText.match(/\{/g) || []).length;
            const closeBraces = (repairedText.match(/\}/g) || []).length;
            const openBrackets = (repairedText.match(/\[/g) || []).length;
            const closeBrackets = (repairedText.match(/\]/g) || []).length;
            
            if (openBrackets > closeBrackets) {
              repairedText += ']'.repeat(openBrackets - closeBrackets);
            }
            if (openBraces > closeBraces) {
              repairedText += '}'.repeat(openBraces - closeBraces);
            }
            try {
              parsedQuiz = JSON.parse(repairedText);
              console.log("[QCM] Robust parser successfully repaired full JSON syntax.");
            } catch (repairError) {
              throw parseError;
            }
          } else {
            throw parseError;
          }
        }
      }
      
      if (!parsedQuiz || !parsedQuiz.questions || !Array.isArray(parsedQuiz.questions)) {
        throw new Error("Format JSON invalide ou impossible à récupérer");
      }

      // Validate, clean questions and deduplicate
      const seenQuestions = new Set<string>();
      const validatedQuestions = parsedQuiz.questions.filter((q: any) => {
        if (!q.question || !Array.isArray(q.options) || q.options.length === 0) return false;
        
        // Normalize question for deduplication check
        const normalizedQ = q.question.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
        if (seenQuestions.has(normalizedQ)) {
          console.warn(`[QCM] Question doublon détectée et ignorée : "${q.question}"`);
          return false;
        }
        seenQuestions.add(normalizedQ);
        
        const rawAns = q.answer;
        let idx = -1;
        if (typeof rawAns === 'number') idx = rawAns;
        else if (typeof rawAns === 'string') {
          const t = rawAns.trim();
          if (/^\d+$/.test(t)) idx = parseInt(t, 10);
          else {
            const m: Record<string, number> = { 'A': 0, 'B': 1, 'C': 2, 'D': 3, 'a': 0, 'b': 1, 'c': 2, 'd': 3 };
            idx = m[t[0]] ?? -1;
          }
        }
        return idx >= 0 && idx < q.options.length;
      });

      if (validatedQuestions.length === 0) {
        throw new Error("Aucune question valide générée");
      }

      parsedQuiz.questions = validatedQuestions;
      setQuizData(parsedQuiz);
      setCurrentQuestionIndex(0);
      setQuizScore(0);
      setSelectedOption(null);
      setIsAnswerChecked(false);
      setQuizState('playing');
    } catch (error: any) {
      console.error("Failed to generate quiz", error);
      setQuizState('setup');
      const errorMsg = error instanceof Error ? error.message : "Raison inconnue";
      alert(`Erreur lors de la génération du QCM : ${errorMsg}\n\nConseils :\n1. Assure-toi que ton modèle de discussion est bien démarré (Port 5000).\n2. Note : Le log "all slots are idle" est tout à fait normal ! C'est un simple message d'état de llama.cpp indiquant que le serveur est allumé, inactif et prêt à recevoir des demandes.`);
    }
  };

  const handleOptionSelect = (index: number) => {
    if (isAnswerChecked) return;
    setSelectedOption(index);
  };

  const getCorrectAnswerIndex = () => {
    if (!quizData) return -1;
    const rawAnswer = quizData.questions[currentQuestionIndex].answer;
    if (typeof rawAnswer === 'number') return rawAnswer;
    if (typeof rawAnswer === 'string') {
      const trimmed = rawAnswer.trim();
      if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
      const map: Record<string, number> = { 'A': 0, 'B': 1, 'C': 2, 'D': 3, 'a': 0, 'b': 1, 'c': 2, 'd': 3 };
      return map[trimmed[0]] ?? -1;
    }
    return -1;
  };

  const checkAnswer = () => {
    if (selectedOption === null || !quizData) return;
    setIsAnswerChecked(true);
    if (selectedOption === getCorrectAnswerIndex()) {
      setQuizScore(prev => prev + 1);
    }
  };

  const nextQuestion = () => {
    if (!quizData) return;
    if (currentQuestionIndex < quizData.questions.length - 1) {
      setCurrentQuestionIndex(prev => prev + 1);
      setSelectedOption(null);
      setIsAnswerChecked(false);
    } else {
      setQuizState('finished');
      // Save result
      const newResult: ExamResult = {
        id: Date.now().toString(),
        date: new Date().toLocaleDateString('fr-FR'),
        subject: `Quiz: ${quizData.theme}`,
        score: quizScore,
        total: quizData.questions.length,
        feedback: "Quiz de révision terminé."
      };
      setExamResults(prev => [newResult, ...prev]);
    }
  };

  const closeQuiz = () => {
    setShowQuizModal(false);
    setQuizState('setup');
    setQuizTheme('');
    setQuizData(null);
  };

  useEffect(() => {
    fetchModels();
  }, []);

  const fetchModels = async () => {
    await fetchGgufModels();
  };

  const pullModel = async () => {
    await downloadModel();
  };

  const deleteModel = async (name: string) => {
    await deleteGgufModel(name);
  };

  const startIndexing = async () => {
    setIsIndexing(true);
    setIndexStatus(null);
    setIndexingProgress({ total: 0, current: 0, fileName: '', status: 'listing' });
    stopIndexingRef.current = false;
    
    try {
      // 1. Get file list
      const listRes = await fetch('/api/index/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          documentsPath: settings.documentsPath,
          llamaConfig: { 
            ip: settings.llamaIp, 
            port: settings.llamaPort, 
            model: settings.selectedModelPath,
            useFlashAttention: settings.useFlashAttention,
            acceleration: settings.acceleration,
            useVulkan: settings.acceleration === "vulkan",
            useCuda: settings.acceleration === "cuda",
            embeddingModelPath: settings.embeddingModelPath
          }
        })
      });
      const listData = await listRes.json();
      
      if (!listRes.ok || !listData.files) {
        throw new Error(listData.error || "Impossible de lister les fichiers");
      }

      const files = listData.files;
      if (files.length === 0) {
        throw new Error("Aucun fichier .pdf ou .txt trouvé");
      }

      if (stopIndexingRef.current) {
        setIndexingProgress(prev => prev ? { ...prev, status: 'stopped' } : null);
        setIsIndexing(false);
        setTimeout(() => setIndexingProgress(null), 3500);
        return;
      }

      setIndexingProgress({ total: files.length, current: 0, fileName: '', status: 'indexing' });

      let totalCount = 0;
      for (let i = 0; i < files.length; i++) {
        if (stopIndexingRef.current) {
          setIndexingProgress(prev => prev ? { ...prev, status: 'stopped' } : null);
          setIsIndexing(false);
          setTimeout(() => setIndexingProgress(null), 3500);
          return;
        }

        const file = files[i];
        setIndexingProgress(prev => prev ? { ...prev, current: i, fileName: file.name } : null);

        const fileRes = await fetch('/api/index/file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            filePath: file.path,
            llamaConfig: { 
              ip: settings.llamaIp, 
              port: settings.llamaPort, 
              model: settings.selectedModelPath,
              useFlashAttention: settings.useFlashAttention,
              acceleration: settings.acceleration,
              useVulkan: settings.acceleration === "vulkan",
              useCuda: settings.acceleration === "cuda",
              embeddingModelPath: settings.embeddingModelPath
            }
          })
        });
        const fileData = await fileRes.json();
        if (fileRes.ok && (fileData.status === 'success' || fileData.status === 'skipped')) {
          totalCount += (fileData.count || 0);
        } else {
          const errMsg = fileData.error || fileData.details || `Erreur d'indexation pour ${file.name}`;
          throw new Error(errMsg);
        }
      }

      if (stopIndexingRef.current) {
        setIndexingProgress(prev => prev ? { ...prev, status: 'stopped' } : null);
        setIsIndexing(false);
        setTimeout(() => setIndexingProgress(null), 3500);
        return;
      }

      setIndexingProgress(prev => prev ? { ...prev, current: files.length, status: 'completed' } : null);
      setIndexStatus({ count: totalCount });
      fetchDbStatus();
      setTimeout(() => setIndexingProgress(null), 3000);
    } catch (error: any) {
      console.error("Failed to index", error);
      setIndexingProgress(prev => prev ? { ...prev, status: 'error' } : null);
      alert(error.message || "Erreur lors de l'indexation");
    } finally {
      setIsIndexing(false);
    }
  };

  const handlePurge = async () => {
    if (!confirm("Voulez-vous vraiment purger toute la base de données ? Cette action est irréversible.")) return;
    
    setIsPurging(true);
    try {
      const res = await fetch('/api/purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (data.status === 'success') {
        alert("Base de données purgée avec succès.");
        setIndexStatus(null);
        fetchDbStatus();
      } else {
        alert(data.error || "Erreur lors de la purge");
      }
    } catch (error) {
      console.error("Failed to purge", error);
      alert("Erreur de connexion au serveur");
    } finally {
      setIsPurging(false);
    }
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setIsCameraActive(true);
      }
    } catch (err) {
      console.error("Error accessing camera:", err);
      alert("Impossible d'accéder à la caméra. Vérifie les permissions.");
    }
  };

  const stopCamera = () => {
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
      setIsCameraActive(false);
    }
  };

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const context = canvasRef.current.getContext('2d');
      if (context) {
        canvasRef.current.width = videoRef.current.videoWidth;
        canvasRef.current.height = videoRef.current.videoHeight;
        context.drawImage(videoRef.current, 0, 0);
        const dataUrl = canvasRef.current.toDataURL('image/jpeg');
        setCapturedImage(dataUrl);
        stopCamera();
      }
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setCapturedImage(event.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const analyzeImage = async () => {
    if (!capturedImage) return;
    
    // Stop current speech when starting analysis
    stopAllSpeech();

    setIsAnalyzing(true);
    try {
      const base64Data = capturedImage.split(',')[1];
      
      // Add user message with placeholder for image
      const userMsg: Message = { role: "user", parts: [{ text: "[Analyse d'image]" }] };
      setMessages(prev => [...prev, userMsg]);
      
      const analysis = await analyzeImageWithLlama(base64Data, settings);
      
      const modelMsg: Message = { role: "model", parts: [{ text: analysis }] };
      setMessages(prev => [...prev, modelMsg]);
      
      // Speak the analysis if audio is enabled
      if (settings.isAudioEnabled) {
        speak(analysis, settings);
      }
      
      setShowImageModal(false);
      setCapturedImage(null);
    } catch (error) {
      console.error("Analysis failed:", error);
      alert("L'analyse de l'image a échoué. Réessaie.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleStopSpeaking = () => {
    stopAllSpeech();
    setIsSpeaking(false);
  };

  const handleStopGeneration = () => {
    if (abortController) {
      abortController.abort();
      setAbortController(null);
    }
    setIsLoading(false);
    stopAllSpeech();
  };

  const fetchDocuments = async () => {
    try {
      const res = await fetch(`/api/documents?documentsPath=${encodeURIComponent(settings.documentsPath)}`);
      const data = await res.json();
      if (data.files) {
        setAvailableDocs(data.files);
      }
    } catch (e) {
      console.error("Failed to fetch documents", e);
    }
  };

  useEffect(() => {
    if (showDocSelector) {
      fetchDocuments();
    }
  }, [showDocSelector, settings.documentsPath]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    if (!settings.selectedModelPath) {
      setShowSettings(true);
      alert("Oups ! Tu dois d'abord choisir un modèle d'IA dans les paramètres (icône ⚙️) pour pouvoir discuter avec moi.");
      return;
    }

    // Stop current speech when sending a new message
    stopAllSpeech();

    const controller = new AbortController();
    setAbortController(controller);

    const userMsg: Message = { role: 'user', parts: [{ text: input }], displayText: input };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    let promptToUse = input;
    let contextForHistory = "";
    let systemPromptOverride = (settings.systemPrompt || DEFAULT_SETTINGS.systemPrompt);

      // RAG Search
      try {
        setRagSearchStatus('searching');
        const searchRes = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ 
            sujet: input,
            settings
          })
        });
        const searchData = await searchRes.json();
        if (searchData.results && searchData.results.length > 0) {
          const context = searchData.results.map((r: any) => r.content).join('\n\n');
          contextForHistory = context;
          promptToUse = `CONTEXTE (SOURCE DE VÉRITÉ EXTRAITE DES MANUELS SCOLAIRES) :\n${context}\n\nIMPORTANT : Tu DOIS utiliser en priorité absolue ce contexte pour formuler ta réponse à l'élève, et mentionner de manière bienveillante et naturelle que tu t'appuies sur le programme scolaire et ses manuels.\n\nQUESTION DE L'ÉLÈVE : ${input}`;
          setRagSearchStatus('found');
          // Short aesthetic transition to let the user see the status change
          await new Promise(resolve => setTimeout(resolve, 800));
        } else {
          setRagSearchStatus('none_found');
          await new Promise(resolve => setTimeout(resolve, 600));
        }
      } catch (e: any) {
        if (e.name !== 'AbortError') {
          console.error("RAG Search failed", e);
        }
        setRagSearchStatus('none_found');
      }

      setRagSearchStatus('generating');

      // Update the user message in history with context if applicable, 
      // but keep the displayed text the same for the UI
      setMessages(prev => {
        const newMessages = [...prev];
        const lastMsg = newMessages[newMessages.length - 1];
        if (lastMsg && lastMsg.role === 'user' && contextForHistory) {
          lastMsg.parts[0].text = promptToUse;
        }
        return newMessages;
      });

      if (isExamMode) {
        systemPromptOverride = `Tu es maintenant en MODE EXAMEN. 
Ta mission :
1. Pose une série de 3 questions précises sur le sujet demandé par l'élève.
2. Attends que l'élève réponde à TOUTES les questions.
3. Une fois les réponses reçues, évalue-les de manière stricte mais juste.
4. Donne une note sur 20.
5. Termine ton message par un bloc JSON formaté exactement comme ceci à la fin : 
RESULTAT_EXAMEN:{"subject": "Sujet", "score": 15, "total": 20, "feedback": "Ton commentaire court"}
Ne sois plus un tuteur maïeutique, sois un examinateur.`;
      }

      // Prepare for streaming
      let accumulatedText = "";
      let sentenceBuffer = "";
      
      // We first add the empty model message to the UI
      setMessages(prev => [...prev, { role: 'model' as const, parts: [{ text: "" }] }]);
      
      // We take the current state of messages (which has the user message in it),
      // and we use that as history
      const historyForAI = [...messages, userMsg];

      // Start the AI call
      try {
        const response = await chatWithAI(historyForAI, promptToUse, { ...settings, systemPrompt: systemPromptOverride }, (chunk) => {
          accumulatedText += chunk;
          sentenceBuffer += chunk;

          // Update the last message in the UI
          setMessages(currentMessages => {
            const updatedMessages = [...currentMessages];
            const lastMessage = updatedMessages[updatedMessages.length - 1];
            if (lastMessage && lastMessage.role === 'model') {
              lastMessage.parts[0].text = accumulatedText;
            }
            return updatedMessages;
          });

          // Check for punctuation to trigger TTS
          const punctuationRegex = /[.!?]/;
          if (punctuationRegex.test(sentenceBuffer)) {
            const lastPuncIndex = Number(math.max(
              sentenceBuffer.lastIndexOf('.'),
              sentenceBuffer.lastIndexOf('!'),
              sentenceBuffer.lastIndexOf('?')
            ));
            
            if (lastPuncIndex !== -1) {
              const sentence = sentenceBuffer.substring(0, lastPuncIndex + 1).trim();
              if (sentence.length > 0 && settings.isAudioEnabled) {
                speak(sentence, settings);
              }
              sentenceBuffer = sentenceBuffer.substring(lastPuncIndex + 1);
            }
          }
        }, controller.signal);
        
        if (response && response.toolsSupported === false) {
          setShowToolWarning(true);
        }

        const finalText = response.text || accumulatedText;
        
        setMessages(currentMessages => {
          const updatedMessages = [...currentMessages];
          const lastMessage = updatedMessages[updatedMessages.length - 1];
          if (lastMessage && lastMessage.role === 'model') {
            lastMessage.parts[0].text = finalText;
          }
          return updatedMessages;
        });
        
        if (sentenceBuffer.trim().length > 0 && settings.isAudioEnabled) {
          speak(sentenceBuffer.trim(), settings);
        }

        // Check for exam results
        if (isExamMode && finalText.includes('RESULTAT_EXAMEN:')) {
          try {
            const jsonStr = finalText.split('RESULTAT_EXAMEN:')[1].trim();
            const resultData = JSON.parse(jsonStr);
            const newResult: ExamResult = {
              id: Date.now().toString(),
              date: new Date().toLocaleDateString('fr-FR'),
              ...resultData
            };
            setExamResults(res => [newResult, ...res]);
            setIsExamMode(false);
          } catch (e) {
            console.error("Failed to parse exam result", e);
          }
        }
      } catch (e: any) {
        if (e.name === 'AbortError') {
          console.log("Generation aborted by user");
        } else {
          console.error("Chat failed", e);
          setMessages(cm => [...cm.slice(0, -1), { role: 'model', parts: [{ text: "Désolé, une erreur est survenue lors de la connexion à l'IA." }] }]);
        }
      } finally {
        setIsLoading(false);
        setAbortController(null);
        setRagSearchStatus('idle');
      }
  };

  const getSpeechText = (text: string) => {
    let cleanText = text;
    const thinkEnd = cleanText.indexOf('</think>');
    if (thinkEnd !== -1) {
      cleanText = cleanText.substring(thinkEnd + 8).trim();
    } else if (cleanText.includes('<think>')) {
      return "";
    }
    
    cleanText = cleanText
      .replace(/\\text{([^}]+)}/g, "$1")
      .replace(/\*/g, '')
      .replace(/#/g, '')
      .replace(/<[^>]*>/g, '')
      .replace(/\$/g, '')
      .replace(/\\frac{([^}]+)}{([^}]+)}/g, "$1 sur $2")
      .replace(/\\times/g, " fois ")
      .replace(/\\div/g, " divisé par ")
      .replace(/\\approx/g, " environ égal à ")
      .replace(/\\neq/g, " différent de ")
      .replace(/\\leq/g, " inférieur ou égal à ")
      .replace(/\\geq/g, " supérieur ou égal à ")
      .replace(/\\pm/g, " plus ou moins ")
      .replace(/\\sqrt{([^}]+)}/g, " racine carrée de $1 ")
      .replace(/\\%/g, " pour cent ")
      .replace(/\^/g, " exposant ")
      .replace(/\\/g, '')
      .replace(/_/g, ' ')
      .replace(/=/g, " égal ")
      .replace(/\+/g, " plus ")
      .replace(/{/g, " ")
      .replace(/}/g, " ")
      .replace(/\s+/g, ' ')
      .trim();

    return cleanText;
  };

  const cleanTextDisplay = (text: string): string => {
    if (!text) return "";
    let cleaned = text;

    // Truncate at leaky ChatML template tokens
    const stopTokens = [
      "<|im_end|>",
      "<|im_start|>",
      "<|im_start|>user",
      "<|im_start|>assistant",
      "<|im_start|>system",
      "<|endoftext|>"
    ];

    for (const token of stopTokens) {
      const index = cleaned.indexOf(token);
      if (index !== -1) {
        cleaned = cleaned.substring(0, index);
      }
    }

    // Clean any remaining dangling tags
    cleaned = cleaned
      .replace(/<\|im_end\|>/gi, "")
      .replace(/<\|im_start\|>\w*/gi, "")
      .replace(/<\|im_start\|>/gi, "");

    // 1. Unescape escaped dollar signs which are extremely common in AI math output (e.g. \$)
    // Convert \$ to $ so they are treated as proper LaTeX math boundaries
    cleaned = cleaned.replace(/\\(?!\\)\$/g, '$');

    // 2. Convert standard escaped LaTeX bracket/parentheses delimiters to standard markdown math blocks
    // \[ ... \] to $$ ... $$ (block display formulas)
    cleaned = cleaned.replace(/\\\[([\s\S]*?)\\\]/g, '$$$$$1$$$$');
    // \( ... \) to $ ... $ (inline formulas)
    cleaned = cleaned.replace(/\\\(([\s\S]*?)\\\)/g, '$$$1$$');

    // 3. Convert literal raw bracket-enclosed formulas if they contain LaTeX keys (e.g. [ \frac{AD}{DB} = \frac{AE}{EC} ]) to display math
    cleaned = cleaned.replace(/\[\s*([\s\S]*?\\(?:frac|angle|triangle|implies|circ|theta|alpha|beta|sqrt|times|cdot|deg|approx|neq|leq|geq|pm|mu|pi|vec|dl|mathbf|text)[\s\S]*?)\s*\]/g, '$$$$\n$1\n$$$$');

    // 4. Convert literal parenthesized formulas if they contain LaTeX keys (e.g. ( \angle B = 90^\circ )) to inline math
    cleaned = cleaned.replace(/\(\s*([^\)]*?\\(?:frac|angle|triangle|implies|circ|theta|alpha|beta|sqrt|times|cdot|deg|approx|neq|leq|geq|pm|mu|pi|vec|dl|mathbf|text)[^\)]*?)\s*\)/g, '$$$1$$');

    // 5. Tokenize text into math blocks and non-math (plain text) blocks to safely auto-wrap unwrapped math
    // Split by existing valid dollar matches: $$...$$ or $...$
    const tokens = cleaned.split(/(\$\$(?:[\s\S]*?)\$\$|\$(?:[^$]*?)\$)/g);
    for (let i = 0; i < tokens.length; i++) {
      // Even indexes are outside math blocks (plain text)
      if (i % 2 === 0) {
        tokens[i] = wrapUnwrappedMathInPlainText(tokens[i]);
      }
    }
    cleaned = tokens.join('');

    function wrapUnwrappedMathInPlainText(textStr: string): string {
      const commandRegex = /\\(frac|angle|triangle|sqrt|theta|alpha|beta|times|cdot|approx|neq|le|ge|implies|pi|sigma|mu|lambda|delta|epsilon|omega|phi|in|circ|deg|prime|sum|int|vec|hat|bar|tilde|cos|sin|tan|mathbf|text|dl|diff|r)\b/g;
      
      let match;
      let matches: { start: number; end: number }[] = [];
      
      while ((match = commandRegex.exec(textStr)) !== null) {
        const commandIdx = match.index;
        
        if (matches.some(m => commandIdx >= m.start && commandIdx < m.end)) {
          continue;
        }
        
        let start = commandIdx;
        while (start > 0) {
          const prevChar = textStr[start - 1];
          
          if (/\s/.test(prevChar)) {
            const leftSub = textStr.substring(0, start - 1);
            const matchWord = leftSub.match(/\b([a-zA-ZÀ-ÿ]+)$/);
            if (matchWord) {
              const word = matchWord[1].toLowerCase();
              const stopWords = ['et', 'est', 'sont', 'dans', 'car', 'avec', 'pour', 'une', 'des', 'les', 'qui', 'que', 'sur', 'par', 'aux', 'le', 'la', 'un', 'du', 'and', 'are', 'with', 'for', 'the', 'is', 'where', 'as', 'at', 'by', 'of', 'or', 'to', 'in', 'when', 'how', 'why', 'mais', 'donc', 'or', 'ni', 'car', 'quel', 'quels', 'quelle', 'quelles'];
              if (stopWords.includes(word)) {
                break;
              }
            }
          }
          
          if (/[a-zA-ZÀ-ÿ0-9_{}()\[\]\\/+\-*×·°√≤≥≠≈=<>:;,\s\u03b1-\u03c9\u0391-\u03a9\u2200-\u22ff\u2190-\u21ff\u20d7\u00d7\u22c5]/.test(prevChar)) {
            if (/[a-zA-ZÀ-ÿ]/.test(prevChar)) {
              const potentialLeftSub = textStr.substring(0, start);
              const wordMatch = potentialLeftSub.match(/([a-zA-ZÀ-ÿ]+)$/);
              if (wordMatch) {
                const word = wordMatch[1].toLowerCase();
                const stopWords = ['et', 'est', 'sont', 'dans', 'car', 'avec', 'pour', 'une', 'des', 'les', 'qui', 'que', 'sur', 'par', 'aux', 'le', 'la', 'un', 'du', 'and', 'are', 'with', 'for', 'the', 'is', 'where'];
                if (stopWords.includes(word) && word.length > 1) {
                  break;
                }
              }
            }
            start--;
          } else {
            break;
          }
        }
        
        while (start < commandIdx && /\s/.test(textStr[start])) {
          start++;
        }
        
        let end = commandIdx + match[0].length;
        while (end < textStr.length) {
          const nextChar = textStr[end];
          
          if (/\s/.test(nextChar)) {
            const rightSub = textStr.substring(end + 1);
            const matchWord = rightSub.match(/^([a-zA-ZÀ-ÿ]+)\b/);
            if (matchWord) {
              const word = matchWord[1].toLowerCase();
              const stopWords = ['et', 'est', 'sont', 'dans', 'car', 'avec', 'pour', 'une', 'des', 'les', 'qui', 'que', 'sur', 'par', 'aux', 'le', 'la', 'un', 'du', 'and', 'are', 'with', 'for', 'the', 'is', 'where', 'as', 'at', 'by', 'of', 'or', 'to', 'in', 'when', 'how', 'why', 'mais', 'donc', 'or', 'ni', 'car', 'quel', 'quels', 'quelle', 'quelles'];
              if (stopWords.includes(word)) {
                break;
              }
            }
          }
          
          if (/[a-zA-ZÀ-ÿ0-9_{}()\[\]\\/+\-*×·°√≤≥≠≈=<>:;,\s\u03b1-\u03c9\u0391-\u03a9\u2200-\u22ff\u2190-\u21ff\u20d7\u00d7\u22c5]/.test(nextChar)) {
            if (/[a-zA-ZÀ-ÿ]/.test(nextChar)) {
              const potentialRightSub = textStr.substring(end);
              const wordMatch = potentialRightSub.match(/^([a-zA-ZÀ-ÿ]+)/);
              if (wordMatch) {
                const word = wordMatch[1].toLowerCase();
                const stopWords = ['et', 'est', 'sont', 'dans', 'car', 'avec', 'pour', 'une', 'des', 'les', 'qui', 'que', 'sur', 'par', 'aux', 'le', 'la', 'un', 'du', 'and', 'are', 'with', 'for', 'the', 'is', 'where'];
                if (stopWords.includes(word) && word.length > 2) {
                  break;
                }
              }
            }
            end++;
          } else {
            break;
          }
        }
        
        while (end > commandIdx && (/\s/.test(textStr[end - 1]) || /[.,;!?:]/.test(textStr[end - 1]))) {
          const lastChar = textStr[end - 1];
          if (/[.,;!?:]/.test(lastChar)) {
            const openBraces = (textStr.substring(start, end).match(/\{/g) || []).length;
            const closeBraces = (textStr.substring(start, end).match(/\}/g) || []).length;
            if (openBraces !== closeBraces) {
              break;
            } else {
              end--;
            }
          } else {
            end--;
          }
        }
        
        if (start < end) {
          matches.push({ start, end });
        }
      }
      
      if (matches.length === 0) return textStr;
      
      matches.sort((a, b) => a.start - b.start);
      
      let result = "";
      let lastIdx = 0;
      for (const item of matches) {
        result += textStr.substring(lastIdx, item.start);
        const mathContent = textStr.substring(item.start, item.end);
        result += `$${mathContent}$`;
        lastIdx = item.end;
      }
      result += textStr.substring(lastIdx);
      
      return result;
    }

    // 6. Balance single dollar signs if odd inside lines
    let lines = cleaned.split('\n');
    lines = lines.map(line => {
      if (!line.trim()) return line;
      const lineNoDouble = line.replace(/\$\$\s*/g, '@@');
      const dollarCount = (lineNoDouble.match(/(?<!\\)\$/g) || []).length;
      
      if (dollarCount % 2 !== 0) {
        const trimmed = line.trim();
        const lastChar = trimmed.slice(-1);
        if (['.', ',', ';', ':', '!'].includes(lastChar)) {
          const lastPuncIdx = line.lastIndexOf(lastChar);
          line = line.substring(0, lastPuncIdx) + '$' + line.substring(lastPuncIdx);
        } else {
          line = line + '$';
        }
      }
      return line;
    });
    cleaned = lines.join('\n');

    // 7. Clean up internal spacing in formulas: e.g. "$ r $" -> "$r$", "$$  math  $$" -> "$$math$$"
    cleaned = cleaned.replace(/\$(?!\$)\s*([\s\S]*?)\s*\$(?!\$)/g, '$$$1$$');
    cleaned = cleaned.replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, '$$$$$1$$$$');

    // 8. Merge adjacent or operator-connected inline math blocks: e.g., "$abc$ = $def$" -> "$abc = def$"
    let previousLength = 0;
    while (cleaned.length !== previousLength) {
      previousLength = cleaned.length;
      cleaned = cleaned.replace(/(?<!\$)\$([^$]+)\$\s*\$([^$]+)\$(?!\$)/g, '$$$1 $2$$');
      cleaned = cleaned.replace(/(?<!\$)\$([^$]+)\$\s*(=|\+|-|\*|\/|\\implies|\\times|\\approx|\\neq|\\le|\\ge|\\cdot|,|;|et|ou|and|or)\s*\$([^$]+)\$(?!\$)/g, '$$$1 $2 $3$$');
    }

    // 9. Remove empty math enclosures that could result from duplicate symbols
    cleaned = cleaned.replace(/\$\$\s*\$\$/g, '');
    cleaned = cleaned.replace(/\$(?!\$)\s*\$(?!\$)/g, '');

    // 10. Balance double dollars globally if odd
    const totalDoubleDollars = (cleaned.match(/\$\s*\$/g) || []).length;
    if (totalDoubleDollars % 2 !== 0) {
      cleaned += '\n$$\n';
    }

    // 11. Replacements for fallback non-math symbols
    cleaned = cleaned.replace(/(?<!\$)\\implies(?!\$)/g, " $\\implies$ ");
    cleaned = cleaned.replace(/\\times/g, "×");

    return cleaned;

    return cleaned;
  };

  const renderMessageContent = (text: string) => {
    const cleanedText = cleanTextDisplay(text);
    const thinkStart = cleanedText.indexOf('<think>');
    const thinkEnd = cleanedText.indexOf('</think>');
    
    if (thinkStart !== -1) {
      let thinking = "";
      let answer = "";
      
      if (thinkEnd !== -1) {
        thinking = cleanedText.substring(thinkStart + 7, thinkEnd);
        answer = cleanedText.substring(thinkEnd + 8).trim();
      } else {
        thinking = cleanedText.substring(thinkStart + 7);
        answer = "";
      }
      
      return (
        <div className="space-y-4">
          <div className="p-4 bg-purple-50/50 border border-purple-100 rounded-xl text-purple-700 text-sm italic">
            <div className="flex items-center gap-2 mb-2 font-bold text-xs uppercase tracking-wider opacity-70">
              <Sparkles size={14} />
              Réflexion du Professeur
            </div>
            <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{thinking}</ReactMarkdown>
          </div>
          {answer && <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{answer}</ReactMarkdown>}
        </div>
      );
    }
    
    return <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{cleanedText}</ReactMarkdown>;
  };

  const speak = async (text: string, settingsOverride?: AppSettings) => {
    const textToSpeak = getSpeechText(text);
    if (!textToSpeak) return;

    setIsSpeaking(true);
    try {
      await ttsSpeak(textToSpeak, settingsOverride || settings);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error("[App] TTS synthesis failed:", errorMsg);
      setMessages(prev => [...prev, { 
        role: 'model', 
        parts: [{ text: `Désolé, la synthèse vocale a échoué: ${errorMsg}` }] 
      }]);
    } finally {
      if (!isAnySpeaking()) {
        setIsSpeaking(false);
      }
    }
  };

  return (
    <div className="flex h-screen bg-[#F8F9FA] text-[#1A1A1A] font-sans selection:bg-indigo-100">
      {/* Sidebar */}
      <aside className="w-72 bg-white border-r border-gray-100 flex flex-col p-6 hidden md:flex">
        <div className="flex items-center gap-3 mb-10">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-200">
            <GraduationCap size={24} />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-gray-900">Professeur IA</h1>
        </div>

        <div className="flex justify-center mb-8">
          <Avatar isSpeaking={isSpeaking} />
        </div>

        <nav className="flex-1 space-y-2">
          <button 
            onClick={() => {
              if(messages.length === 0 || confirm("Démarrer une nouvelle discussion ? L'historique actuel sera effacé.")) {
                handleStopGeneration();
                setMessages([]);
              }
            }}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-gray-700 hover:bg-indigo-50 hover:text-indigo-700 transition-all"
          >
            <MessageSquarePlus size={18} />
            <span className="font-medium">Nouvelle discussion</span>
          </button>
          <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4 px-2 mt-4">Outils de révision</div>
          <button 
            onClick={() => setShowDocSelector(true)}
            className={cn(
              "w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all",
              showDocSelector ? "bg-indigo-50 text-indigo-700 font-medium" : "text-gray-500 hover:bg-gray-50"
            )}
          >
            <BookOpen size={18} />
            <span>Manuels Scolaires</span>
          </button>
          <button 
            onClick={() => setShowQuizModal(true)}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-gray-500 hover:bg-gray-50 transition-all"
          >
            <CheckCircle2 size={18} />
            <span>Quiz de révision (QCM)</span>
          </button>
        </nav>

        <div className="mt-auto p-4 bg-indigo-50 rounded-2xl border border-indigo-100">
          <div className="flex items-center gap-2 text-indigo-700 font-semibold mb-1">
            <Sparkles size={16} />
            <span className="text-sm">Mode Local-First</span>
          </div>
          <p className="text-xs text-indigo-600/80 leading-relaxed">
            Tes données sont stockées localement pour ta vie privée.
          </p>
        </div>
      </aside>

      {/* Main Chat Area */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        {/* Header */}
        <header className="h-16 border-bottom border-gray-100 bg-white/80 backdrop-blur-md flex items-center justify-between px-4 md:px-8 sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <div className="md:hidden flex items-center justify-center w-10 h-10">
              <Avatar isSpeaking={isSpeaking} scale={0.2} />
            </div>
            <div className="hidden md:flex items-center gap-2">
              <div className={cn(
                "w-2 h-2 rounded-full animate-pulse",
                isEngineConnected ? "bg-emerald-500" : "bg-red-500"
              )} />
              <span className="text-sm font-medium text-gray-600">
                {isEngineConnected ? 'opérationnel' : 'non opérationnel'}
              </span>
            </div>
          </div>
          {showToolWarning && (
            <div className="flex items-center gap-2 px-3 py-1 bg-amber-50 border border-amber-200 rounded-full text-amber-700 text-xs animate-in fade-in slide-in-from-top-2">
              <AlertCircle size={14} />
              <span>Le modèle actuel ne supporte pas les outils (calculatrice désactivée).</span>
              <button onClick={() => setShowToolWarning(false)} className="ml-1 hover:text-amber-900">
                <X size={12} />
              </button>
            </div>
          )}
          <div className="flex items-center gap-4">
            <button 
              onClick={() => setShowSettings(true)}
              className="p-2 text-gray-400 hover:text-indigo-600 transition-colors"
            >
              <SettingsIcon size={20} />
            </button>
            {isSpeaking && (
              <button 
                onClick={handleStopSpeaking}
                className="p-2 text-red-500 hover:text-red-700 transition-colors animate-pulse"
                title="Arrêter la lecture"
              >
                <VolumeX size={20} />
              </button>
            )}
            <button 
              onClick={() => setSettings({...settings, isAudioEnabled: !settings.isAudioEnabled})}
              className={cn(
                "p-2 transition-colors",
                settings.isAudioEnabled ? "text-indigo-600" : "text-gray-400 hover:text-indigo-600"
              )}
              title={settings.isAudioEnabled ? "Désactiver l'audio" : "Activer l'audio"}
            >
              {settings.isAudioEnabled ? <Volume2 size={20} /> : <VolumeX size={20} />}
            </button>
          </div>
        </header>

        {/* Indexation Progress Banner */}
        {indexingProgress && (indexingProgress.status === 'listing' || indexingProgress.status === 'indexing') && (
          <div className="bg-indigo-50 border-b border-indigo-100 px-6 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-in slide-in-from-top duration-300 shadow-sm z-20">
            <div className="flex items-center gap-3 overflow-hidden">
              <span className="flex h-2.5 w-2.5 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-indigo-600"></span>
              </span>
              <div className="flex flex-col text-xs overflow-hidden">
                <span className="font-bold text-indigo-900 uppercase tracking-wider text-[10px]">
                  {indexingProgress.status === 'listing' ? "Scan du dossier en cours..." : "Indexation des cours en cours..."}
                </span>
                <span className="text-gray-600 truncate max-w-sm font-medium">
                  {indexingProgress.fileName || "Analyse initialisation..."}
                </span>
              </div>
              <span className="text-[10px] bg-indigo-100 text-indigo-800 font-bold px-2 py-0.5 rounded-full whitespace-nowrap">
                {indexingProgress.current} / {indexingProgress.total} Fichiers
              </span>
            </div>
            <div className="flex items-center justify-between sm:justify-end gap-4">
              <div className="w-36 bg-gray-200 h-1.5 rounded-full overflow-hidden hidden md:block">
                <div 
                  className="bg-indigo-600 h-full transition-all duration-300"
                  style={{ width: indexingProgress.total > 0 ? `${(indexingProgress.current / indexingProgress.total) * 100}%` : '30%' }}
                />
              </div>
              <button
                onClick={() => {
                  stopIndexingRef.current = true;
                }}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 active:scale-95 text-white text-xs font-bold rounded-xl flex items-center gap-2 transition-all shadow-sm shrink-0 uppercase tracking-wider text-[10px]"
              >
                <XCircle size={14} />
                Arrêter l'indexation
              </button>
            </div>
          </div>
        )}

        {/* Dashboard Modal */}
        <AnimatePresence>
          {showDashboard && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            >
              <motion.div 
                initial={{ scale: 0.95, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.95, y: 20 }}
                className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
              >
                <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-indigo-600 text-white">
                  <div className="flex items-center gap-3">
                    <BarChart3 size={24} />
                    <h2 className="text-xl font-bold">Tableau de Bord & Suivi</h2>
                  </div>
                  <button onClick={() => setShowDashboard(false)} className="p-2 hover:bg-white/20 rounded-full transition-colors">
                    <X size={24} />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-8">
                  {/* Stats Summary */}
                  <div className="grid grid-cols-3 gap-4">
                    <div className="bg-indigo-50 p-4 rounded-2xl border border-indigo-100">
                      <div className="text-xs font-bold text-indigo-400 uppercase mb-1">Examens</div>
                      <div className="text-3xl font-black text-indigo-600">{examResults.length}</div>
                    </div>
                    <div className="bg-emerald-50 p-4 rounded-2xl border border-emerald-100">
                      <div className="text-xs font-bold text-emerald-400 uppercase mb-1">Moyenne</div>
                      <div className="text-3xl font-black text-emerald-600">
                        {examResults.length > 0 
                          ? (examResults.reduce((acc, r) => acc + r.score, 0) / examResults.length).toFixed(1) 
                          : "-"}
                      </div>
                    </div>
                    <div className="bg-amber-50 p-4 rounded-2xl border border-amber-100">
                      <div className="text-xs font-bold text-amber-400 uppercase mb-1">Progression</div>
                      <div className="text-3xl font-black text-amber-600">
                        {examResults.length > 1 ? "↑ 12%" : "Stable"}
                      </div>
                    </div>
                  </div>

                  {/* Recent Results */}
                  <div className="space-y-4">
                    <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wider flex items-center gap-2">
                      <History size={16} />
                      Historique des Examens
                    </h3>
                    
                    {examResults.length === 0 ? (
                      <div className="text-center py-12 bg-gray-50 rounded-3xl border-2 border-dashed border-gray-200">
                        <GraduationCap size={48} className="mx-auto text-gray-300 mb-4" />
                        <p className="text-gray-500 font-medium">Aucun examen réalisé pour le moment.</p>
                        <button 
                          onClick={() => { setShowDashboard(false); setIsExamMode(true); }}
                          className="mt-4 text-indigo-600 font-bold hover:underline"
                        >
                          Lancer ton premier test
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {examResults.map((result) => (
                          <div key={result.id} className="p-4 bg-white border border-gray-100 rounded-2xl shadow-sm hover:shadow-md transition-shadow flex items-center justify-between">
                            <div className="flex items-center gap-4">
                              <div className={cn(
                                "w-12 h-12 rounded-xl flex items-center justify-center font-black text-lg",
                                result.score >= 15 ? "bg-emerald-100 text-emerald-600" : 
                                result.score >= 10 ? "bg-amber-100 text-amber-600" : "bg-red-100 text-red-600"
                              )}>
                                {result.score}
                              </div>
                              <div>
                                <div className="font-bold text-gray-800">{result.subject}</div>
                                <div className="text-xs text-gray-400">{result.date}</div>
                              </div>
                            </div>
                            <div className="text-right max-w-[200px]">
                              <div className="text-xs text-gray-500 italic line-clamp-2">"{result.feedback}"</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Mastered Topics */}
                  <div className="space-y-4">
                    <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wider flex items-center gap-2">
                      <CheckCircle2 size={16} />
                      Notions Maîtrisées
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {["Photosynthèse", "Pythagore", "Révolution Française", "Cellule Végétale"].map(topic => (
                        <span key={topic} className="px-3 py-1.5 bg-emerald-50 text-emerald-600 rounded-full text-xs font-bold border border-emerald-100">
                          {topic}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="p-4 bg-gray-50 border-t border-gray-100 flex justify-end">
                  <button 
                    onClick={() => { if(confirm("Effacer tout l'historique ?")) setExamResults([]); }}
                    className="text-xs text-red-400 hover:text-red-600 font-medium flex items-center gap-1"
                  >
                    <Trash2 size={12} />
                    Réinitialiser les données
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Settings Modal */}
        <AnimatePresence>
          {showSettings && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
              >
                <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-indigo-50/50">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white">
                      <SettingsIcon size={20} />
                    </div>
                    <div>
                      <h2 className="text-lg font-bold text-gray-900">Paramètres du Professeur</h2>
                      <p className="text-xs text-gray-500">Configure ton IA et tes documents</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => setShowSettings(false)}
                    className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                  >
                    <X size={20} />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-8 space-y-8">
                  {/* System Prompt */}
                  <section className="space-y-3">
                    <label className="flex items-center gap-2 text-sm font-bold text-gray-700">
                      <Sparkles size={16} className="text-indigo-500" />
                      Posture Pédagogique (System Prompt)
                    </label>
                    <textarea 
                      value={settings.systemPrompt}
                      onChange={(e) => setSettings({...settings, systemPrompt: e.target.value})}
                      className="w-full h-40 p-4 bg-gray-50 border border-gray-200 rounded-2xl text-sm text-gray-600 focus:ring-2 focus:ring-indigo-500 outline-none transition-all resize-none"
                      placeholder="Définis comment le professeur doit se comporter..."
                    />
                  </section>

                  {/* Documents Path */}
                  <section className="space-y-4 p-6 bg-gray-50 rounded-2xl border border-gray-100">
                    <label className="flex items-center gap-2 text-sm font-bold text-gray-700">
                      <FileText size={16} className="text-indigo-500" />
                      Dossier des Documents (RAG)
                    </label>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <input 
                          type="text"
                          value={settings.documentsPath}
                          onChange={(e) => setSettings({...settings, documentsPath: e.target.value})}
                          className="w-full pl-3 pr-10 py-3 bg-white border border-gray-200 rounded-xl text-sm outline-none focus:border-indigo-400"
                          placeholder="/workspace/cours"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const nextState = !showFolderBrowser;
                            setShowFolderBrowser(nextState);
                            if (nextState) {
                              browseFolder(settings.documentsPath || undefined);
                            }
                          }}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-gray-400 hover:text-indigo-600 transition-colors"
                          title="Parcourir les dossiers"
                        >
                          {showFolderBrowser ? <FolderOpen size={18} /> : <Folder size={18} />}
                        </button>
                      </div>
                      <button 
                        onClick={startIndexing}
                        disabled={isIndexing || !settings.documentsPath}
                        className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700 transition-all flex items-center gap-2 shadow-sm disabled:opacity-50 flex-shrink-0"
                      >
                        {isIndexing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                        Indexer
                      </button>
                    </div>

                    {showFolderBrowser && (
                      <div className="p-4 bg-white border border-gray-200 rounded-xl space-y-3 shadow-md mt-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                            Explorateur de dossiers local
                          </span>
                          <button
                            type="button"
                            onClick={() => setShowFolderBrowser(false)}
                            className="text-xs text-gray-500 hover:text-indigo-600 font-semibold"
                          >
                            Fermer
                          </button>
                        </div>

                        {/* Current Path with parent arrow */}
                        <div className="flex items-center gap-2 bg-slate-50 p-2.5 rounded-xl text-xs font-mono text-slate-600 overflow-hidden border border-slate-100">
                          {folderBrowserParentPath !== null && (
                            <button
                              type="button"
                              onClick={() => browseFolder(folderBrowserParentPath)}
                              className="p-1 px-1.5 bg-white border border-slate-200 hover:border-slate-300 text-slate-500 rounded-md hover:bg-slate-50 flex-shrink-0 transition-all"
                              title="Dossier parent"
                            >
                              <ArrowUp size={12} />
                            </button>
                          )}
                          <span className="truncate break-all">{folderBrowserPath || "Chargement..."}</span>
                        </div>

                        {folderBrowserError && (
                          <p className="text-[11px] text-red-500 italic bg-red-50 p-2 rounded-lg">{folderBrowserError}</p>
                        )}

                        {/* List directories */}
                        <div className="max-h-52 overflow-y-auto space-y-1 border border-slate-100 rounded-xl p-1 divide-y divide-slate-50 bg-slate-50/50">
                          {folderBrowserDirectories.length === 0 ? (
                            <p className="text-[11px] text-gray-400 italic text-center py-5">Aucun sous-dossier disponible.</p>
                          ) : (
                            folderBrowserDirectories.map((dir) => (
                              <div key={dir.path} className="flex items-center justify-between py-1.5 px-2 hover:bg-white hover:shadow-sm rounded-lg transition-all group">
                                <button
                                  type="button"
                                  onClick={() => browseFolder(dir.path)}
                                  className="flex items-center gap-2 text-xs font-semibold text-gray-700 hover:text-indigo-600 text-left truncate flex-1"
                                >
                                  <Folder size={14} className="text-gray-400 group-hover:text-indigo-500 flex-shrink-0" />
                                  <span className="truncate">{dir.name}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSettings({ ...settings, documentsPath: dir.path });
                                    setShowFolderBrowser(false);
                                  }}
                                  className="text-[10px] bg-indigo-50 hover:bg-indigo-600 hover:text-white text-indigo-700 border border-indigo-100 hover:border-indigo-600 rounded px-2.5 py-0.5 font-bold transition-all ml-2"
                                >
                                  Sélectionner
                                </button>
                              </div>
                            ))
                          )}
                        </div>

                        <div className="pt-1">
                          <button
                            type="button"
                            onClick={() => {
                              setSettings({ ...settings, documentsPath: folderBrowserPath });
                              setShowFolderBrowser(false);
                            }}
                            className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl transition-all shadow-sm"
                          >
                            Sélectionner le dossier actuel ("{getFolderName(folderBrowserPath) || "racine"}")
                          </button>
                        </div>
                      </div>
                    )}

                     {indexingProgress && (
                      <div className="space-y-2 mt-2 bg-slate-50 p-3 rounded-xl border border-gray-100">
                        <div className="flex justify-between items-center text-[10px] font-bold text-gray-500 uppercase">
                          <span className="truncate max-w-[200px]">
                            {indexingProgress.status === 'listing' && "Scan du dossier..."}
                            {indexingProgress.status === 'indexing' && `Indexation: ${indexingProgress.fileName}`}
                            {indexingProgress.status === 'completed' && "Indexation terminée !"}
                            {indexingProgress.status === 'stopped' && "Indexation arrêtée."}
                            {indexingProgress.status === 'error' && "Erreur d'indexation"}
                          </span>
                          <div className="flex items-center gap-2">
                            {indexingProgress.total > 0 && (
                              <span>{indexingProgress.current} / {indexingProgress.total}</span>
                            )}
                            {(indexingProgress.status === 'listing' || indexingProgress.status === 'indexing') && (
                              <button
                                type="button"
                                onClick={() => { stopIndexingRef.current = true; }}
                                className="px-2 py-0.5 bg-red-600 hover:bg-red-700 text-white font-bold rounded text-[9px] uppercase tracking-wider flex items-center gap-1 transition-all"
                              >
                                <XCircle size={10} />
                                Arrêter
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                          <motion.div 
                            initial={{ width: 0 }}
                            animate={{ 
                              width: indexingProgress.total > 0 
                                ? `${(indexingProgress.current / indexingProgress.total) * 100}%` 
                                : indexingProgress.status === 'listing' ? '30%' : '0%' 
                            }}
                            className={cn(
                              "h-full transition-all duration-500",
                              indexingProgress.status === 'error' ? "bg-red-500" : 
                              indexingProgress.status === 'stopped' ? "bg-amber-500" : "bg-indigo-600"
                            )}
                          />
                        </div>
                      </div>
                    )}

                    {indexStatus && !indexingProgress && (
                      <p className="text-[10px] text-emerald-600 font-bold flex items-center gap-1">
                        <CheckCircle2 size={10} />
                        {indexStatus.count} segments indexés avec succès !
                      </p>
                    )}
                    
                    {dbStatus?.connected && (
                      <div className="bg-white rounded-xl p-3 border border-gray-100 shadow-sm space-y-2 mt-2">
                        <div className="flex items-center justify-between border-b border-gray-50 pb-1.5">
                          <span className="text-[11px] font-bold text-gray-700 flex items-center gap-1.5">
                            <span className="flex h-1.5 w-1.5 relative">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
                            </span>
                            Base de Données LanceDB
                          </span>
                          <span className="text-[9px] px-1.5 py-0.2 bg-emerald-50 text-emerald-700 font-mono rounded font-bold uppercase tracking-wider scale-90">Opérationnel</span>
                        </div>
                        <div className="grid grid-cols-1 gap-1">
                          {dbStatus.tables?.length === 0 ? (
                            <span className="text-[10px] text-gray-400 italic font-mono">Aucune table active.</span>
                          ) : (
                            dbStatus.tables.map(t => (
                              <div key={t.name} className="flex justify-between items-center text-[10px] font-mono text-gray-600 bg-gray-50 px-2.5 py-1.5 rounded-lg border border-gray-100/60">
                                <span className="font-semibold text-gray-700">
                                  {t.name === 'manuels' ? '🎒 Documents Manuels' : t.name === 'web_text_chunks' ? '🌐 Pages Web Indexées' : t.name === 'web_image_chunks' ? '🖼️ Images Vectorisées' : t.name}
                                </span>
                                <span className="text-indigo-600 font-bold px-2 py-0.5 bg-indigo-50/70 border border-indigo-100/50 rounded-md text-[9px]">{t.count} segments</span>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}

                    <p className="text-[10px] text-gray-400 italic">
                      Supporte les fichiers .pdf et .txt. L\'indexation et la vectorisation s\'effectuent localement dans LanceDB.
                    </p>
                  </section>

                  {/* Llama.cpp Config & Binaries Manager */}
                  <section className="space-y-4 p-6 bg-gray-50 rounded-2xl border border-gray-100">
                    <div className="flex items-center justify-between">
                      <label className="flex items-center gap-2 text-sm font-bold text-gray-700">
                        <Globe size={16} className="text-indigo-500" />
                        Configuration Llama.cpp & Serveur
                      </label>
                      <div className="flex gap-2">
                        <span className={cn(
                          "text-[10px] px-2 py-0.5 rounded-full font-bold uppercase",
                          llamaStatus.running ? "bg-emerald-100 text-emerald-700 animate-pulse" : "bg-gray-200 text-gray-600"
                        )}>
                          Discussion (5000): {llamaStatus.running ? "Actif" : "Inactif"}
                        </span>
                        {llamaStatus.embeddingRunning && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase bg-indigo-100 text-indigo-700 animate-pulse">
                            Embeddings (5001): Actif
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="space-y-4 pt-2">
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <span className="text-xs font-semibold text-gray-500 uppercase">Adresse IP</span>
                          <input 
                            type="text"
                            value={settings.llamaIp}
                            onChange={(e) => setSettings({...settings, llamaIp: e.target.value})}
                            className="w-full p-3 bg-white border border-gray-200 rounded-xl text-sm outline-none focus:border-indigo-400"
                            placeholder="127.0.0.1"
                          />
                        </div>
                        <div className="space-y-2">
                          <span className="text-xs font-semibold text-gray-500 uppercase">Port</span>
                          <input 
                            type="text"
                            value={settings.llamaPort}
                            onChange={(e) => setSettings({...settings, llamaPort: e.target.value})}
                            className="w-full p-3 bg-white border border-gray-200 rounded-xl text-sm outline-none focus:border-indigo-400"
                            placeholder="5000"
                          />
                        </div>
                      </div>

                      {/* Acceleration Selector */}
                      <div className="space-y-2">
                        <span className="text-xs font-semibold text-gray-500 uppercase">Moteur d'accélération</span>
                        <div className="grid grid-cols-3 gap-2">
                          {['cpu', 'vulkan', 'cuda'].map((type) => (
                            <button
                              key={type}
                              type="button"
                              onClick={() => setSettings({...settings, acceleration: type as any})}
                              className={cn(
                                "py-2 px-3 rounded-xl text-xs font-bold border transition-all text-center uppercase",
                                settings.acceleration === type 
                                  ? "bg-indigo-600 text-white border-indigo-600 shadow-sm" 
                                  : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
                              )}
                            >
                              {type}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Choice of Embedding Model Section */}
                      <div className="space-y-3 pt-3 border-t border-gray-200">
                        <span className="text-xs font-semibold text-gray-500 uppercase block">Modèle d'embedding (Serveur Port 5001)</span>
                        <div className="space-y-2">
                          <select
                            value={settings.embeddingModelPath || ""}
                            onChange={(e) => {
                              const value = e.target.value;
                              setSettings({...settings, embeddingModelPath: value});
                            }}
                            className="w-full p-2.5 bg-white border border-gray-200 rounded-xl text-xs outline-none focus:border-indigo-400 font-medium text-gray-700"
                          >
                            <option value="">-- Sélectionner un modèle d'embedding GGUF --</option>
                            {ggufModels.map((m) => {
                              const isEmbed = m.name.toLowerCase().includes("embed") ||
                                              m.name.toLowerCase().includes("nomic") ||
                                              m.name.toLowerCase().includes("bge") ||
                                              m.name.toLowerCase().includes("minilm");
                              return (
                                <option key={m.path} value={m.path}>
                                  {m.name} {isEmbed ? "✨ (Recommandé Embedding)" : ""}
                                </option>
                              );
                            })}
                          </select>

                          <div className="flex gap-2">
                            {llamaStatus.embeddingRunning && llamaStatus.embeddingModelPath === settings.embeddingModelPath ? (
                              <button
                                type="button"
                                onClick={stopLlamaEmbeddingServer}
                                className="text-[10px] px-2 py-1.5 bg-red-50 border border-red-200 text-red-600 rounded-lg font-bold hover:bg-red-100 transition-colors w-full text-center"
                              >
                                Arrêter le serveur d'embedding (Port 5001)
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => settings.embeddingModelPath && startLlamaEmbeddingServer(settings.embeddingModelPath)}
                                disabled={!settings.embeddingModelPath}
                                className={cn(
                                  "text-[10px] px-2 py-1.5 rounded-lg font-bold transition-colors w-full border text-center",
                                  settings.embeddingModelPath
                                    ? "bg-emerald-50 border-emerald-200 text-emerald-600 hover:bg-emerald-100 cursor-pointer"
                                    : "bg-gray-50 border-gray-100 text-gray-300 cursor-not-allowed"
                                )}
                              >
                                Démarrer le serveur d'embedding (Port 5001)
                              </button>
                            )}
                          </div>

                          {llamaStatus.embeddingModelPath && (
                            <div className="text-[10px] text-gray-500 font-mono bg-white p-2.5 rounded-lg border border-gray-100/80 break-all leading-normal">
                              <span className="font-semibold text-indigo-600">Actif : </span>
                              {llamaStatus.embeddingModelPath.split(/[/\\]/).pop()}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Llama.cpp Binaries (GitHub downloader) */}
                      <div className="space-y-3 pt-3 border-t border-gray-200">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold text-gray-700 uppercase tracking-wider">
                            Binaires Officiels (ggml-org/llama.cpp)
                          </span>
                          <span className="text-[10px] font-medium text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-md">
                            Mise à jour : {latestBinaryTag}
                          </span>
                        </div>

                        <div className="space-y-2">
                          <button
                            onClick={downloadAllBinaries}
                            disabled={llamaStatus.downloadProgress?.status === "downloading" || llamaStatus.downloadProgress?.status === "extracting"}
                            className="w-full flex items-center justify-center gap-2 p-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl font-medium transition-all shadow-md shadow-indigo-100/50"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                            </svg>
                            <span>Télécharger tous les binaires de calcul (CPU, Vulkan, CUDA)</span>
                          </button>
                          
                          <div className="flex items-center justify-between px-1 text-[10px] text-gray-400 font-mono uppercase tracking-wider">
                            <span className="flex items-center gap-1">
                              CPU : {llamaStatus.binaries?.cpu ? <span className="text-green-600 font-bold">✓ Prêt</span> : <span className="text-gray-400">✗ Manquant</span>}
                            </span>
                            <span className="flex items-center gap-1">
                              Vulkan : {llamaStatus.binaries?.vulkan ? <span className="text-green-600 font-bold">✓ Prêt</span> : <span className="text-gray-400">✗ Manquant</span>}
                            </span>
                            <span className="flex items-center gap-1">
                              CUDA : {llamaStatus.binaries?.cuda ? <span className="text-green-600 font-bold">✓ Prêt</span> : <span className="text-gray-400">✗ Manquant</span>}
                            </span>
                          </div>
                        </div>

                        {llamaStatus.downloadProgress?.status === "downloading" && (
                          <div className="space-y-1 p-2.5 bg-indigo-50 rounded-xl border border-indigo-100">
                            <div className="flex justify-between text-[11px] font-semibold text-indigo-700">
                              <span>Mise à jour du binaire...</span>
                              <span>{llamaStatus.downloadProgress.progress}%</span>
                            </div>
                            <div className="w-full bg-indigo-200 h-2 rounded-full overflow-hidden">
                              <div 
                                className="bg-indigo-600 h-full transition-all duration-300" 
                                style={{ width: `${llamaStatus.downloadProgress.progress}%` }}
                              />
                            </div>
                          </div>
                        )}
                        {llamaStatus.downloadProgress?.status === "extracting" && (
                          <div className="text-center py-1 text-xs text-indigo-600 font-medium animate-pulse">
                            Extraction de l'archive tar.gz...
                          </div>
                        )}
                      </div>

                      {/* Models Downloader (Hugging Face) */}
                      <div className="space-y-3 pt-3 border-t border-gray-200">
                        <span className="text-[11px] font-bold text-gray-700 uppercase tracking-wider block">
                          Télécharger un modèle GGUF depuis Hugging Face
                        </span>
                        
                        <div className="space-y-2">
                          <input 
                            type="text"
                            value={hfModelUrl}
                            onChange={(e) => setHfModelUrl(e.target.value)}
                            placeholder="Lien de téléchargement direct (.gguf)"
                            className="w-full p-2.5 bg-white border border-gray-200 rounded-xl text-xs outline-none focus:border-indigo-400"
                          />
                          <button 
                            onClick={downloadModel}
                            disabled={llamaStatus.modelDownloadProgress?.status === "downloading" || !hfModelUrl.trim()}
                            className="w-full py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700 transition-all flex items-center justify-center gap-2"
                          >
                            <Download size={14} />
                            Lancer le téléchargement
                          </button>
                        </div>

                        {llamaStatus.modelDownloadProgress?.status === "downloading" && (
                          <div className="space-y-1 p-2.5 bg-indigo-50 rounded-xl border border-indigo-100">
                            <div className="flex justify-between text-[11px] font-semibold text-indigo-700">
                              <span>Téléchargement du modèle...</span>
                              <span>{llamaStatus.modelDownloadProgress.progress}%</span>
                            </div>
                            <div className="w-full bg-indigo-200 h-2 rounded-full overflow-hidden">
                              <div 
                                className="bg-indigo-600 h-full transition-all duration-300" 
                                style={{ width: `${llamaStatus.modelDownloadProgress.progress}%` }}
                              />
                            </div>
                            <p className="text-[10px] text-indigo-400 italic text-right">
                              {(llamaStatus.modelDownloadProgress.current / 1024 / 1024 / 1024).toFixed(1)} GB / {(llamaStatus.modelDownloadProgress.total / 1024 / 1024 / 1024).toFixed(1)} GB
                            </p>
                          </div>
                        )}
                      </div>

                      {/* GGUF Local Models Management */}
                      <div className="space-y-3 pt-3 border-t border-gray-200">
                        <span className="text-[11px] font-bold text-gray-700 uppercase tracking-wider block">
                          Modèles GGUF présents localement
                        </span>

                        <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                          {(() => {
                            const chatModels = ggufModels.filter((m) => {
                              const lf = m.name.toLowerCase();
                              return !(lf.includes("embed") || lf.includes("nomic") || lf.includes("bge") || lf.includes("minilm"));
                            });
                            
                            return chatModels.length === 0 ? (
                              <p className="text-[11px] text-gray-400 italic py-1 text-center font-mono">Aucun modèle de discussion GGUF disponible. Télécharges-en un avec le lien ci-dessus !</p>
                            ) : (
                              chatModels.map((m) => {
                                const isActiveText = settings.selectedModelPath === m.path;
                                const isServerText = llamaStatus.modelPath === m.path && llamaStatus.running;
                                return (
                                  <div key={m.name} className="p-3 bg-white border border-gray-100 rounded-xl text-xs flex flex-col gap-2.5 shadow-sm hover:shadow-md transition-shadow">
                                    <div className="flex items-start justify-between">
                                      <div className="flex items-start gap-2.5">
                                        <input 
                                          type="radio" 
                                          checked={isActiveText}
                                          onChange={() => setSettings({...settings, selectedModelPath: m.path})}
                                          className="text-indigo-600 focus:ring-indigo-500 h-4 w-4 mt-0.5 cursor-pointer"
                                        />
                                        <div className="space-y-0.5">
                                          <span className="font-bold text-gray-800 break-all">{m.name}</span>
                                          <p className="text-[10px] text-gray-400 font-mono">Taille: {(m.size / 1024 / 1024 / 1024).toFixed(1)} GB</p>
                                        </div>
                                      </div>
                                      <button 
                                        onClick={() => deleteGgufModel(m.name)}
                                        className="p-1 text-gray-300 hover:text-red-500 transition-colors shrink-0"
                                        title="Supprimer le modèle"
                                      >
                                        <Trash2 size={13} />
                                      </button>
                                    </div>

                                    {/* Action Button */}
                                    <div className="flex justify-between gap-2 border-t border-gray-50 pt-2">
                                      {isServerText ? (
                                        <button
                                          onClick={stopLlamaServer}
                                          className="text-[10px] px-2 py-1.5 bg-red-50 border border-red-200 text-red-600 rounded-md font-bold hover:bg-red-100 transition-colors w-full text-center"
                                        >
                                          Arrêter le serveur (Port 5000)
                                        </button>
                                      ) : (
                                        <button
                                          onClick={() => startLlamaServer(m.path)}
                                          disabled={!isActiveText}
                                          className={cn(
                                            "text-[10px] px-2 py-1.5 rounded-md font-bold transition-colors w-full border text-center",
                                            isActiveText 
                                              ? "bg-emerald-50 border-emerald-200 text-emerald-600 hover:bg-emerald-100"
                                              : "bg-gray-50 border-gray-100 text-gray-300 cursor-not-allowed"
                                          )}
                                          title={isActiveText ? "Lancer le serveur de discussion" : "Sélectionnez d'abord ce modèle"}
                                        >
                                          Démarrer le serveur (Port 5000)
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                );
                              })
                            );
                          })()}
                        </div>
                      </div>

                      {/* Llama.cpp live server logs output */}
                      {llamaStatus.logs?.length > 0 && (
                        <div className="space-y-1.5 pt-3 border-t border-gray-200">
                          <span className="text-[11px] font-bold text-gray-700 uppercase tracking-wider block">
                            Console de déboguage llama-server
                          </span>
                          <div className="w-full bg-slate-900 rounded-xl p-3 h-32 overflow-y-auto font-mono text-[9px] text-slate-300 antialiased leading-relaxed leading-3 scrollbar-thin">
                            {llamaStatus.logs.map((log: string, idx: number) => (
                              <div key={idx} className="whitespace-pre-wrap">{log}</div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Thinking Mode Toggle */}
                      <div className="flex items-center justify-between p-3 bg-white rounded-xl border border-gray-100 shadow-sm mt-3">
                        <div className="flex items-center gap-3">
                          <div className="p-2 bg-purple-50 rounded-lg text-purple-600">
                            <Sparkles size={18} />
                          </div>
                          <div>
                            <p className="text-sm font-bold text-gray-900">Mode Thinking</p>
                            <p className="text-[11px] text-gray-500">Active le raisonnement détaillé (si supporté par le modèle)</p>
                          </div>
                        </div>
                        <button 
                          onClick={() => setSettings({...settings, isThinkingEnabled: !settings.isThinkingEnabled})}
                          className={cn(
                            "w-12 h-6 rounded-full transition-all relative",
                            settings.isThinkingEnabled ? "bg-purple-600" : "bg-gray-300"
                          )}
                        >
                          <div className={cn(
                            "absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm",
                            settings.isThinkingEnabled ? "left-7" : "left-1"
                          )} />
                        </button>
                      </div>
                    </div>

                    {/* Pre-Quantized Cache Warning (Non-optional Q8 always applied) */}
                    <div className="p-3 bg-amber-50 border border-amber-100 rounded-xl flex items-center gap-2">
                      <Zap size={14} className="text-amber-600 flex-shrink-0" />
                      <p className="text-[10px] text-amber-700">
                        La <strong>compression KV Cache en Q8</strong> et le <strong>Flash Attention</strong> sont injectés et configurés par défaut pour maximiser les performances de calcul local.
                      </p>
                    </div>
                  </section>

                  {/* Web Scraping Config */}
                  <section className="space-y-4 p-6 bg-gray-50 rounded-2xl border border-gray-100">
                    <label className="flex items-center gap-2 text-sm font-bold text-gray-700">
                      <Globe size={16} className="text-indigo-500" />
                      Web Scraping Local (RAG)
                    </label>
                    
                    <div className="space-y-3">
                      <div className="flex gap-2">
                        <input 
                          type="text"
                          value={newUrl}
                          onChange={(e) => setNewUrl(e.target.value)}
                          placeholder="https://exemple.com/article"
                          className="flex-1 p-3 bg-white border border-gray-200 rounded-xl text-sm outline-none focus:border-indigo-400"
                        />
                        <button 
                          onClick={addUrl}
                          className="p-3 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all"
                        >
                          <Plus size={18} />
                        </button>
                      </div>

                      <div className="space-y-2 max-h-32 overflow-y-auto pr-2">
                        {settings.urlsToScrape.length === 0 ? (
                          <p className="text-xs text-gray-400 italic">Aucune URL ajoutée.</p>
                        ) : (
                          settings.urlsToScrape.map(url => (
                            <div key={url} className="flex items-center justify-between p-2 bg-white border border-gray-100 rounded-lg text-[11px]">
                              <span className="truncate flex-1 mr-2 text-gray-600">{url}</span>
                              <button onClick={() => removeUrl(url)} className="text-red-400 hover:text-red-600">
                                <Trash2 size={14} />
                              </button>
                            </div>
                          ))
                        )}
                      </div>

                      <button 
                        onClick={startScraping}
                        disabled={isScraping || settings.urlsToScrape.length === 0}
                        className="w-full py-3 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700 transition-all flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
                      >
                        {isScraping ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                        Synchroniser les URLs
                      </button>

                      {scrapeProgress && (
                        <div className="space-y-2 mt-4">
                          <div className="flex justify-between text-[10px] font-bold text-gray-500 uppercase">
                            <span>{scrapeProgress.status === 'scraping' ? `Scraping: ${scrapeProgress.currentUrl}` : scrapeProgress.status}</span>
                            <span>{scrapeProgress.completedUrls} / {scrapeProgress.totalUrls}</span>
                          </div>
                          <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                            <motion.div 
                              initial={{ width: 0 }}
                              animate={{ width: `${scrapeProgress.status === 'completed' ? 100 : (scrapeProgress.completedUrls / scrapeProgress.totalUrls) * 100}%` }}
                              className="h-full bg-indigo-600"
                            />
                          </div>
                          {scrapeProgress.status === 'scraping' && (
                            <div className="flex justify-between text-[9px] text-indigo-400 italic">
                              <span>Indexation du contenu...</span>
                              <span>{scrapeProgress.progress}%</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <p className="text-[10px] text-gray-400 italic">
                      Extrait le contenu propre, génère des vecteurs Qwen3-Embedding pour le texte et les images.
                    </p>
                  </section>

                  {/* TTS Config */}
                  <section className="space-y-4 p-6 bg-gray-50 rounded-2xl border border-gray-100">
                    <label className="flex items-center gap-2 text-sm font-bold text-gray-700">
                      <Volume2 size={16} className="text-indigo-500" />
                      Synthèse Vocale (TTS)
                    </label>
                    
                    <div className="flex items-center justify-between p-3 bg-white rounded-xl border border-gray-100 shadow-sm">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-indigo-50 rounded-lg text-indigo-600">
                          <Volume2 size={18} />
                        </div>
                        <div>
                          <p className="text-sm font-bold text-gray-900">Lecture audio automatique</p>
                          <p className="text-[11px] text-gray-500">Lire les réponses à haute voix par défaut</p>
                        </div>
                      </div>
                      <button 
                        onClick={() => setSettings({...settings, isAudioEnabled: !settings.isAudioEnabled})}
                        className={cn(
                          "w-12 h-6 rounded-full transition-all relative",
                          settings.isAudioEnabled ? "bg-indigo-600" : "bg-gray-300"
                        )}
                      >
                        <div className={cn(
                          "absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm",
                          settings.isAudioEnabled ? "left-7" : "left-1"
                        )} />
                      </button>
                    </div>

                    <div className="space-y-3 pt-2">
                      <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Moteur de synthèse</span>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={() => setSettings({...settings, ttsProvider: 'browser'})}
                          className={cn(
                            "p-3 rounded-xl border text-xs font-bold transition-all flex flex-col items-center gap-1",
                            settings.ttsProvider === 'browser' 
                              ? "bg-indigo-600 text-white border-indigo-600 shadow-md" 
                              : "bg-white text-gray-600 border-gray-200 hover:border-indigo-300"
                          )}
                        >
                          <span>Navigateur</span>
                          <span className="text-[9px] font-normal opacity-80">Local & Privé</span>
                        </button>
                        <button
                          onClick={() => setSettings({...settings, ttsProvider: 'google'})}
                          className={cn(
                            "p-3 rounded-xl border text-xs font-bold transition-all flex flex-col items-center gap-1",
                            settings.ttsProvider === 'google' 
                              ? "bg-indigo-600 text-white border-indigo-600 shadow-md" 
                              : "bg-white text-gray-600 border-gray-200 hover:border-indigo-300"
                          )}
                        >
                          <span>Google TTS</span>
                          <span className="text-[9px] font-normal opacity-80">Gratuit & Rapide</span>
                        </button>
                      </div>
                      
                      {settings.ttsProvider === 'google' && (
                        <div className="p-3 bg-blue-50 border border-blue-100 rounded-xl flex gap-3 items-start">
                          <AlertCircle size={16} className="text-blue-500 shrink-0 mt-0.5" />
                          <div className="space-y-1">
                            <p className="text-[10px] font-bold text-blue-800 uppercase">Connexion Internet requise</p>
                            <p className="text-[10px] text-blue-700 leading-relaxed">
                              Google TTS nécessite une connexion Internet active. Les textes sont traités via les serveurs de traduction de Google pour la synthèse vocale.
                            </p>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="pt-2">
                      <button 
                        onClick={() => speak("Bonjour, je suis ton professeur IA", settings)}
                        className="w-full py-2 bg-indigo-50 text-indigo-600 rounded-xl text-xs font-bold hover:bg-indigo-100 transition-all flex items-center justify-center gap-2"
                      >
                        <Play size={14} />
                        Tester la voix
                      </button>
                    </div>
                  </section>

                  {/* Danger Zone */}
                  <section className="space-y-4 p-6 bg-red-50/50 rounded-2xl border border-red-100">
                    <label className="flex items-center gap-2 text-sm font-bold text-red-700">
                      <AlertCircle size={16} className="text-red-500" />
                      Zone de Danger
                    </label>
                    
                    <button 
                      onClick={handlePurge}
                      disabled={isPurging}
                      className="w-full py-3 bg-white border border-red-200 text-red-600 rounded-xl text-xs font-bold hover:bg-red-50 transition-all flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
                    >
                      {isPurging ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                      Purger toute la base de données
                    </button>
                    <p className="text-[10px] text-red-400 italic text-center">
                      Supprime tous les documents indexés, les URLs et le cache des images.
                    </p>
                  </section>
                </div>

                <div className="p-6 border-t border-gray-100 flex justify-end gap-3">
                  <button 
                    onClick={() => setShowSettings(false)}
                    className="px-6 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 rounded-xl transition-colors"
                  >
                    Annuler
                  </button>
                  <button 
                    onClick={() => setShowSettings(false)}
                    className="px-6 py-2 bg-indigo-600 text-white text-sm font-bold rounded-xl hover:bg-indigo-700 shadow-lg shadow-indigo-200 flex items-center gap-2 transition-all"
                  >
                    <Save size={18} />
                    Enregistrer
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Quiz Modal */}
        <AnimatePresence>
          {showQuizModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/40 backdrop-blur-sm">
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]"
              >
                <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-indigo-50/50">
                  <div className="flex items-center gap-3 text-indigo-600">
                    <div className="p-2 bg-indigo-100 rounded-xl">
                      <GraduationCap size={24} />
                    </div>
                    <h2 className="text-xl font-bold">Mode Révision (QCM)</h2>
                  </div>
                  <button 
                    onClick={closeQuiz}
                    className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl transition-colors"
                  >
                    <X size={20} />
                  </button>
                </div>

                <div className="p-8 overflow-y-auto flex-1">
                  {quizState === 'setup' && (
                    <div className="space-y-6">
                      <div className="text-center space-y-2">
                        <div className="w-24 h-24 bg-indigo-100 rounded-3xl mx-auto flex items-center justify-center text-indigo-600 mb-6 overflow-hidden">
                          <Avatar isSpeaking={false} scale={0.5} />
                        </div>
                        <h3 className="text-2xl font-bold text-gray-900">Sur quel thème veux-tu réviser ?</h3>
                        <p className="text-gray-500">Je vais te générer un QCM sur mesure pour tester tes connaissances.</p>
                      </div>
                      
                      <div className="relative">
                        <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                          <Search className="h-5 w-5 text-gray-400" />
                        </div>
                        <input
                          type="text"
                          value={quizTheme}
                          onChange={(e) => setQuizTheme(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && generateQuiz()}
                          placeholder="Ex: La Révolution Française, Les fractions..."
                          className="w-full pl-11 pr-4 py-4 bg-gray-50 border border-gray-200 rounded-2xl text-lg outline-none focus:border-indigo-400 focus:bg-white transition-all shadow-sm"
                        />
                      </div>

                      <div className="space-y-3">
                        <div className="flex justify-between items-center text-sm font-bold text-gray-700">
                          <label>Nombre de questions</label>
                          <span className="px-3 py-1 bg-indigo-100 text-indigo-600 rounded-lg">{quizQuestionCount}</span>
                        </div>
                        <input 
                          type="range" 
                          min="3" 
                          max="20" 
                          step="1"
                          value={quizQuestionCount}
                          onChange={(e) => setQuizQuestionCount(parseInt(e.target.value))}
                          className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                        />
                        <div className="flex justify-between text-[10px] text-gray-400 font-medium px-1">
                          <span>3</span>
                          <span>10</span>
                          <span>20</span>
                        </div>
                      </div>
                      
                      <button
                        onClick={generateQuiz}
                        disabled={!quizTheme.trim()}
                        className="w-full py-4 bg-indigo-600 text-white font-bold rounded-2xl hover:bg-indigo-700 disabled:opacity-50 disabled:hover:bg-indigo-600 transition-all shadow-lg shadow-indigo-200 flex items-center justify-center gap-2"
                      >
                        <Sparkles size={20} />
                        Générer mon QCM
                      </button>
                    </div>
                  )}

                  {quizState === 'loading' && (
                    <div className="py-12 flex flex-col items-center justify-center text-center space-y-6">
                      <Loader2 size={48} className="animate-spin text-indigo-600" />
                      <div>
                        <h3 className="text-xl font-bold text-gray-900 mb-2">Préparation de ton QCM...</h3>
                        <p className="text-gray-500">Je cherche les meilleures questions sur "{quizTheme}"</p>
                      </div>
                    </div>
                  )}

                  {quizState === 'playing' && quizData && (
                    <div className="space-y-8">
                      <div className="flex items-center justify-between text-sm font-medium text-gray-500">
                        <span className="px-3 py-1 bg-indigo-50 text-indigo-600 rounded-lg">
                          Question {currentQuestionIndex + 1} / {quizData.questions.length}
                        </span>
                        <span className="px-3 py-1 bg-green-50 text-green-600 rounded-lg">
                          Score: {quizScore}
                        </span>
                      </div>
                      
                      <h3 className="text-2xl font-bold text-gray-900 leading-tight">
                        {quizData.questions[currentQuestionIndex].question}
                      </h3>
                      
                      <div className="space-y-3">
                        {quizData.questions[currentQuestionIndex].options.map((option, index) => {
                          const isSelected = selectedOption === index;
                          const isCorrect = index === getCorrectAnswerIndex();
                          
                          let buttonClass = "w-full p-4 text-left border rounded-2xl transition-all text-lg ";
                          
                          if (!isAnswerChecked) {
                            buttonClass += isSelected 
                              ? "border-indigo-600 bg-indigo-50 text-indigo-700 shadow-sm" 
                              : "border-gray-200 hover:border-indigo-300 hover:bg-gray-50 text-gray-700";
                          } else {
                            if (isCorrect) {
                              buttonClass += "border-green-500 bg-green-50 text-green-700 shadow-sm";
                            } else if (isSelected && !isCorrect) {
                              buttonClass += "border-red-500 bg-red-50 text-red-700 shadow-sm";
                            } else {
                              buttonClass += "border-gray-200 opacity-50 text-gray-500";
                            }
                          }
                          
                          return (
                            <button
                              key={index}
                              onClick={() => handleOptionSelect(index)}
                              disabled={isAnswerChecked}
                              className={buttonClass}
                            >
                              <div className="flex items-center justify-between">
                                <span>{option}</span>
                                {isAnswerChecked && isCorrect && <CheckCircle2 size={20} className="text-green-600" />}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      
                      {isAnswerChecked && (
                        <motion.div 
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="p-5 bg-blue-50 border border-blue-100 rounded-2xl text-blue-800 space-y-2"
                        >
                          <p className="font-bold flex items-center gap-2">
                            <Bot size={18} />
                            Explication du prof :
                          </p>
                          <p className="leading-relaxed">
                            {quizData.questions[currentQuestionIndex].explanation}
                          </p>
                        </motion.div>
                      )}
                    </div>
                  )}

                  {quizState === 'finished' && quizData && (
                    <div className="py-8 text-center space-y-6">
                      <div className="w-24 h-24 mx-auto bg-green-100 text-green-600 rounded-full flex items-center justify-center mb-4">
                        <CheckCircle2 size={48} />
                      </div>
                      <h3 className="text-3xl font-bold text-gray-900">Quiz Terminé !</h3>
                      <p className="text-gray-500 text-lg">Voici ton score final sur le thème "{quizData.theme}"</p>
                      
                      <div className="text-6xl font-black text-indigo-600 py-4">
                        {quizScore} <span className="text-3xl text-gray-400">/ {quizData.questions.length}</span>
                      </div>
                      
                      <div className="pt-6 border-t border-gray-100">
                        <button
                          onClick={closeQuiz}
                          className="px-8 py-4 bg-indigo-600 text-white font-bold rounded-2xl hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200"
                        >
                          Retourner au chat
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {quizState === 'playing' && quizData && (
                  <div className="p-6 border-t border-gray-100 bg-gray-50 flex justify-end">
                    {!isAnswerChecked ? (
                      <button
                        onClick={checkAnswer}
                        disabled={selectedOption === null}
                        className="px-8 py-3 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 disabled:opacity-50 disabled:hover:bg-indigo-600 transition-all shadow-md"
                      >
                        Valider ma réponse
                      </button>
                    ) : (
                      <button
                        onClick={nextQuestion}
                        className="px-8 py-3 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 transition-all shadow-md flex items-center gap-2"
                      >
                        {currentQuestionIndex < quizData.questions.length - 1 ? 'Question suivante' : 'Voir les résultats'}
                      </button>
                    )}
                  </div>
                )}
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Messages */}
        <div 
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-8 space-y-8 scroll-smooth"
        >
          {settings.selectedModelPath === "" && (
            <motion.div 
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              className="max-w-3xl mx-auto p-5 bg-amber-50 border border-amber-200 rounded-2xl flex items-center gap-5 text-amber-800 shadow-sm"
            >
              <div className="p-3 bg-amber-100 rounded-2xl text-amber-600 shadow-inner">
                <AlertCircle size={28} />
              </div>
              <div className="flex-1">
                <p className="font-bold text-lg mb-1">Attention : Aucun modèle d'IA sélectionné</p>
                <p className="text-sm opacity-90 leading-relaxed">
                  Pour pouvoir discuter avec moi, tu dois d'abord choisir un modèle d'IA (ton "cerveau") dans les paramètres.
                </p>
              </div>
              <button 
                onClick={() => setShowSettings(true)}
                className="px-6 py-3 bg-amber-600 text-white text-sm font-bold rounded-xl hover:bg-amber-700 transition-all shadow-md active:scale-95"
              >
                Choisir un modèle
              </button>
            </motion.div>
          )}

          {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto space-y-6">
              <div className="w-20 h-20 bg-indigo-100 rounded-3xl flex items-center justify-center text-indigo-600 overflow-hidden">
                <Avatar isSpeaking={isSpeaking} scale={0.4} />
              </div>
              <div>
                <h2 className="text-2xl font-bold text-gray-900 mb-2">Salut ! Je suis ton Professeur IA.</h2>
                <p className="text-gray-500 leading-relaxed">
                  Je suis là pour t'aider à comprendre tes cours, pas juste te donner les réponses. On commence par quoi aujourd'hui ?
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3 w-full">
                {['Explique-moi Pythagore', 'C\'est quoi la photosynthèse ?', 'Aide-moi en Histoire', 'Quiz de révision'].map((hint) => (
                  <button 
                    key={hint}
                    onClick={() => setInput(hint)}
                    className="px-4 py-2 text-sm bg-white border border-gray-200 rounded-xl hover:border-indigo-300 hover:bg-indigo-50 transition-all text-gray-600"
                  >
                    {hint}
                  </button>
                ))}
              </div>
            </div>
          )}

          <AnimatePresence initial={false}>
            {messages.map((msg, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={cn(
                  "flex gap-4 max-w-3xl",
                  msg.role === 'user' ? "ml-auto flex-row-reverse" : "mr-auto"
                )}
              >
                <div className={cn(
                  "w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 shadow-sm overflow-hidden",
                  msg.role === 'user' ? "bg-indigo-600 text-white" : "bg-white border border-gray-100 text-indigo-600"
                )}>
                  {msg.role === 'user' ? <User size={20} /> : <Avatar isSpeaking={isSpeaking} scale={0.2} />}
                </div>
                <div className={cn(
                  "group relative p-5 rounded-2xl text-[15px] leading-relaxed shadow-sm",
                  msg.role === 'user' 
                    ? "bg-indigo-600 text-white rounded-tr-none" 
                    : "bg-white border border-gray-100 text-gray-800 rounded-tl-none"
                )}>
                  <div className="prose prose-sm max-w-none prose-p:leading-relaxed prose-pre:bg-gray-900 prose-pre:text-gray-100">
                    {msg.role === 'model' ? renderMessageContent(msg.parts[0].text) : <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{msg.displayText || msg.parts[0].text}</ReactMarkdown>}
                  </div>
                  
                  {msg.role === 'model' && (
                    <button 
                      onClick={() => speak(msg.parts[0].text)}
                      className="absolute -right-12 top-0 p-2 text-gray-400 hover:text-indigo-600 opacity-0 group-hover:opacity-100 transition-all"
                    >
                      <Volume2 size={18} />
                    </button>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {isLoading && (
            <div className="flex gap-4 mr-auto">
              <div className="w-10 h-10 rounded-xl bg-white border border-gray-100 flex items-center justify-center text-indigo-600 shadow-sm">
                <Bot size={20} />
              </div>
              <div className="bg-white border border-gray-100 p-5 rounded-2xl rounded-tl-none shadow-sm flex items-center gap-3">
                <Loader2 size={18} className="animate-spin text-indigo-600" />
                <div className="flex flex-col text-left">
                  {ragSearchStatus === 'searching' && (
                    <>
                      <span className="text-sm font-semibold text-indigo-600">🔍 Recherche RAG...</span>
                      <span className="text-xs text-gray-500">Recherche d'informations fiables dans vos manuels scolaires et documents...</span>
                    </>
                  )}
                  {ragSearchStatus === 'found' && (
                    <>
                      <span className="text-sm font-semibold text-emerald-600">📖 Documents trouvés !</span>
                      <span className="text-xs text-gray-400">Contextes officiels extraits et injectés pour guider le Professeur...</span>
                    </>
                  )}
                  {ragSearchStatus === 'none_found' && (
                    <>
                      <span className="text-sm font-semibold text-amber-600">🔍 Recherche RAG terminée</span>
                      <span className="text-xs text-gray-500">Aucun document spécifique trouvé. Utilisation des connaissances éducatives...</span>
                    </>
                  )}
                  {ragSearchStatus === 'generating' && (
                    <>
                      <span className="text-sm font-semibold text-indigo-600">✍️ Le professeur rédige sa réponse...</span>
                      <span className="text-xs text-gray-500">Explications claires adaptées à ton niveau.</span>
                    </>
                  )}
                  {ragSearchStatus === 'idle' && (
                    <span className="text-sm text-gray-500 font-medium italic">Le professeur réfléchit...</span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Input Area */}
        <div className="p-8 pt-0">
          <div className="max-w-3xl mx-auto relative group">
            <div className="absolute -inset-1 bg-gradient-to-r from-indigo-500 to-purple-500 rounded-2xl blur opacity-20 group-focus-within:opacity-40 transition duration-1000"></div>
            <div className="relative flex items-center bg-white border border-gray-200 rounded-2xl shadow-xl overflow-hidden focus-within:border-indigo-400 transition-all">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                placeholder="Pose ta question ici..."
                className="flex-1 px-6 py-5 outline-none text-gray-700 placeholder:text-gray-400"
              />
              <div className="flex items-center gap-2 px-4">
                <button 
                  onClick={() => setShowImageModal(true)}
                  className="p-3 text-gray-400 hover:text-indigo-600 hover:bg-gray-50 rounded-xl transition-all"
                  title="Analyser une image"
                >
                  <Camera size={20} />
                </button>
                {isLoading ? (
                  <button 
                    onClick={handleStopGeneration}
                    className="bg-red-500 text-white p-3 rounded-xl hover:bg-red-600 transition-all shadow-lg shadow-red-200"
                    title="Arrêter la génération"
                  >
                    <Square size={20} fill="currentColor" />
                  </button>
                ) : (
                  <button 
                    onClick={handleSend}
                    disabled={!input.trim()}
                    className="bg-indigo-600 text-white p-3 rounded-xl hover:bg-indigo-700 disabled:opacity-50 disabled:hover:bg-indigo-600 transition-all shadow-lg shadow-indigo-200"
                  >
                    <Send size={20} />
                  </button>
                )}
              </div>
            </div>
          </div>
          <p className="text-center text-[11px] text-gray-400 mt-4 font-medium uppercase tracking-widest">
            Propulsé par llama-server & RAG Local
          </p>
        </div>

        {/* Document Selector Modal */}
        <AnimatePresence>
          {showDocSelector && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            >
              <motion.div 
                initial={{ scale: 0.95, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.95, y: 20 }}
                className="bg-white w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[70vh]"
              >
                <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-indigo-600 text-white">
                  <div className="flex items-center gap-3">
                    <BookOpen size={24} />
                    <h2 className="text-xl font-bold">Mes Manuels</h2>
                  </div>
                  <button onClick={() => setShowDocSelector(false)} className="p-2 hover:bg-white/20 rounded-full transition-colors">
                    <X size={24} />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-3">
                  {availableDocs.length === 0 ? (
                    <div className="text-center py-12">
                      <FileText size={48} className="mx-auto text-gray-200 mb-4" />
                      <p className="text-gray-500 font-medium">Aucun manuel trouvé dans le dossier.</p>
                      <p className="text-xs text-gray-400 mt-2">Vérifie le chemin dans les réglages.</p>
                    </div>
                  ) : (
                    availableDocs.map((doc) => (
                      <button 
                        key={doc.path}
                        onClick={() => {
                          setSelectedDoc(doc);
                          setShowDocSelector(false);
                        }}
                        className="w-full p-4 bg-white border border-gray-100 rounded-2xl shadow-sm hover:shadow-md hover:border-indigo-200 transition-all flex items-center gap-4 text-left group"
                      >
                        <div className="w-12 h-12 bg-indigo-50 rounded-xl flex items-center justify-center text-indigo-600 group-hover:bg-indigo-600 group-hover:text-white transition-colors">
                          <FileText size={24} />
                        </div>
                        <div className="flex-1 overflow-hidden">
                          <div className="font-bold text-gray-800 truncate">{doc.name}</div>
                          <div className="text-xs text-gray-400 truncate">{doc.path}</div>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* PDF Viewer */}
        {selectedDoc && (
          <PDFAnnotationViewer 
            documentPath={selectedDoc.path}
            documentName={selectedDoc.name}
            onClose={() => setSelectedDoc(null)}
          />
        )}

        {/* Image Analysis Modal */}
        <AnimatePresence>
          {showImageModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
              <motion.div 
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
              >
                <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-indigo-50/50">
                  <div className="flex items-center gap-3 text-indigo-600">
                    <div className="p-2 bg-indigo-100 rounded-xl">
                      <Camera size={24} />
                    </div>
                    <h2 className="text-xl font-bold">Analyse d'Image Multimodale</h2>
                  </div>
                  <button 
                    onClick={() => {
                      stopCamera();
                      setShowImageModal(false);
                      setCapturedImage(null);
                    }}
                    className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl transition-colors"
                  >
                    <X size={20} />
                  </button>
                </div>

                <div className="p-8 overflow-y-auto flex-1 space-y-6">
                  {!capturedImage && !isCameraActive && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <button 
                        onClick={startCamera}
                        className="flex flex-col items-center justify-center p-10 border-2 border-dashed border-gray-200 rounded-3xl hover:border-indigo-400 hover:bg-indigo-50 transition-all group"
                      >
                        <div className="w-16 h-16 bg-indigo-100 rounded-2xl flex items-center justify-center text-indigo-600 mb-4 group-hover:scale-110 transition-transform">
                          <Camera size={32} />
                        </div>
                        <span className="font-bold text-gray-700">Utiliser la caméra</span>
                        <span className="text-xs text-gray-400 mt-1">Prendre une photo en direct</span>
                      </button>
                      
                      <button 
                        onClick={() => fileInputRef.current?.click()}
                        className="flex flex-col items-center justify-center p-10 border-2 border-dashed border-gray-200 rounded-3xl hover:border-indigo-400 hover:bg-indigo-50 transition-all group"
                      >
                        <div className="w-16 h-16 bg-indigo-100 rounded-2xl flex items-center justify-center text-indigo-600 mb-4 group-hover:scale-110 transition-transform">
                          <ImageIcon size={32} />
                        </div>
                        <span className="font-bold text-gray-700">Choisir un fichier</span>
                        <span className="text-xs text-gray-400 mt-1">Importer depuis ton appareil</span>
                        <input 
                          type="file" 
                          ref={fileInputRef} 
                          onChange={handleFileUpload} 
                          accept="image/*" 
                          className="hidden" 
                        />
                      </button>
                    </div>
                  )}

                  {isCameraActive && (
                    <div className="relative rounded-2xl overflow-hidden bg-black aspect-video flex items-center justify-center">
                      <video 
                        ref={videoRef} 
                        autoPlay 
                        playsInline 
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute bottom-6 left-0 right-0 flex justify-center gap-4">
                        <button 
                          onClick={capturePhoto}
                          className="w-16 h-16 bg-white rounded-full flex items-center justify-center shadow-xl hover:scale-110 transition-transform text-indigo-600"
                        >
                          <div className="w-12 h-12 border-4 border-indigo-600 rounded-full"></div>
                        </button>
                        <button 
                          onClick={stopCamera}
                          className="px-6 py-2 bg-black/50 text-white rounded-full text-sm font-bold backdrop-blur-md hover:bg-black/70 transition-all"
                        >
                          Annuler
                        </button>
                      </div>
                    </div>
                  )}

                  {capturedImage && (
                    <div className="space-y-6">
                      <div className="relative rounded-2xl overflow-hidden border border-gray-200 shadow-lg">
                        <img src={capturedImage} alt="Captured" className="w-full h-auto max-h-[400px] object-contain bg-gray-50" />
                        <button 
                          onClick={() => setCapturedImage(null)}
                          className="absolute top-4 right-4 p-2 bg-black/50 text-white rounded-full backdrop-blur-md hover:bg-black/70 transition-all"
                        >
                          <X size={16} />
                        </button>
                      </div>
                      
                      <button 
                        onClick={analyzeImage}
                        disabled={isAnalyzing}
                        className="w-full py-4 bg-indigo-600 text-white font-bold rounded-2xl hover:bg-indigo-700 disabled:opacity-50 disabled:hover:bg-indigo-600 transition-all shadow-lg shadow-indigo-200 flex items-center justify-center gap-2"
                      >
                        {isAnalyzing ? (
                          <>
                            <Loader2 size={20} className="animate-spin" />
                            Analyse en cours...
                          </>
                        ) : (
                          <>
                            <Sparkles size={20} />
                            Analyser l'image avec l'IA
                          </>
                        )}
                      </button>
                    </div>
                  )}
                  
                  <canvas ref={canvasRef} className="hidden" />
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}