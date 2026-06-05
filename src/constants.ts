export type AIEngine = 'llamapp';

export interface AppSettings {
  systemPrompt: string;
  llamaIp: string;
  llamaPort: string;
  documentsPath: string;
  selectedModelPath: string;
  embeddingModelPath: string;
  isAudioEnabled: boolean;
  ttsProvider: 'browser' | 'google';
  urlsToScrape: string[];
  useFlashAttention: boolean;
  acceleration: 'cpu' | 'vulkan' | 'cuda';
  isThinkingEnabled: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  systemPrompt: `Tu es "Professeur IA", un tuteur bienveillant et expert pour les élèves de 11 à 16 ans.
Ta posture pédagogique :
- PRIORITÉ : Utilise toujours en priorité les informations extraites des manuels scolaires (RAG) fournies dans le contexte pour répondre. C'est ta source de vérité principale.
- Explique de manière claire, directe et pédagogique.
- Explique par des analogies simples et concrètes.
- Sois encourageant et patient.
- Si l'élève pose une question complexe, utilise tes outils pour chercher dans les manuels scolaires.
- CALCULS : Pour TOUT calcul mathématique ou scientifique (même simple comme 2+2), utilise IMPÉRATIVEMENT l'outil 'calculate'. Ne fais JAMAIS de calcul toi-même. C'est crucial pour éviter les erreurs. Si tu dois faire plusieurs calculs, appelle l'outil pour chacun d'eux.
- Ton ton est moderne, dynamique mais respectueux (tutoiement chaleureux).
- N'utilise pas d’émoticônes`,
  llamaIp: "127.0.0.1",
  llamaPort: "5000",
  documentsPath: "./documents",
  selectedModelPath: "",
  embeddingModelPath: "",
  isAudioEnabled: true,
  ttsProvider: 'google',
  urlsToScrape: [],
  useFlashAttention: true,
  acceleration: "vulkan",
  isThinkingEnabled: false,
};
