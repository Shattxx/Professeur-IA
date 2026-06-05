import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createRequire } from "module";
import { glob } from "glob";
import { createServer as createViteServer } from "vite";
import * as lancedb from "@lancedb/lancedb";
import fetch from "node-fetch";
import { fetchAndClean } from "./src/services/scraper";
import { PDFParse } from "pdf-parse";
import { random } from "mathjs";
import { indexWebPage, isUrlIndexed, searchVectorDb, getEmbeddings, getDetectedEmbeddingDimension, resolveEmbeddingDimension, getManuelsSchema, getTextSchema, getImageSchema, chunkText } from "./src/services/vectorDb";
import gtts from "google-tts-api";
import { spawn, execSync } from "child_process";

const require = createRequire(import.meta.url);

console.log("[Server] pdf-parse import:", typeof PDFParse === 'function' ? "Success (class found)" : `Failed (type: ${typeof PDFParse})`);
if (typeof PDFParse !== 'function') {
  console.log("[Server] PDFParse keys:", Object.keys(PDFParse || {}));
}

console.log("[Server] Entry point reached.");

process.on("uncaughtException", (err) => {
  console.error("[Server] Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[Server] Unhandled Rejection at:", promise, "reason:", reason);
});

// Llama.cpp background process state
let llamaChildProcess: any = null;
let llamaEmbeddingChildProcess: any = null;
let llamaLogs: string[] = [];
let currentModelPath: string = "";
let currentEmbeddingModelPath: string = "";
let currentAcceleration: string = "vulkan";
let lastBinaryTag: string = "b9382"; // Default fallback tag

let downloadProgress = { status: "idle", progress: 0, total: 0, current: 0, error: null as string | null };
let modelDownloadProgress = { status: "idle", progress: 0, total: 0, current: 0, error: null as string | null };

function logLlama(text: string) {
  const cleanLine = text.trim();
  if (!cleanLine) return;
  console.log(`[LlamaServer] ${cleanLine}`);
  llamaLogs.push(`[${new Date().toLocaleTimeString()}] ${cleanLine}`);
  if (llamaLogs.length > 250) llamaLogs.shift();
}

async function killProcessOnPort(port: number) {
  logLlama(`Recherche et arrêt de tout processus sur le port ${port}...`);
  try {
    if (process.platform === "win32") {
      try {
        const output = execSync(`netstat -ano | findstr :${port}`).toString();
        const lines = output.split("\n");
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5) {
            const pid = parts[parts.length - 1];
            if (pid && pid !== "0" && /^\d+$/.test(pid)) {
              logLlama(`Arrêt du processus PID ${pid} sur le port ${port}`);
              execSync(`taskkill /f /pid ${pid}`, { stdio: "ignore" });
            }
          }
        }
      } catch (err) {
        // findstr code 1 or normal errors if process doesn't exist
      }
    } else {
      try {
        execSync(`fuser -k ${port}/tcp`, { stdio: "ignore" });
      } catch (e) {
        try {
          execSync(`lsof -t -i:${port} | xargs kill -9`, { stdio: "ignore" });
        } catch(err) {}
      }
    }
  } catch (error: any) {
    console.error(`Erreur lors de l'arrêt du processus de port ${port}:`, error.message || error);
  }
}

async function stopLlamaServer() {
  if (llamaChildProcess) {
    logLlama("Arrêt du serveur llama-server...");
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /pid ${llamaChildProcess.pid} /f /t`);
      } else {
        process.kill(-llamaChildProcess.pid); // kill process group
      }
    } catch (e) {
      try {
        llamaChildProcess.kill("SIGKILL");
      } catch (err) {}
    }
    llamaChildProcess = null;
    logLlama("Serveur llama-server arrêté.");
  }
  // Clear any zombie process on port 5000
  await killProcessOnPort(5000);
}

async function stopLlamaEmbeddingServer() {
  if (llamaEmbeddingChildProcess) {
    logLlama("Arrêt du serveur llama-server d'embedding (port 5001)...");
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /pid ${llamaEmbeddingChildProcess.pid} /f /t`);
      } else {
        process.kill(-llamaEmbeddingChildProcess.pid); // kill process group
      }
    } catch (e) {
      try {
        llamaEmbeddingChildProcess.kill("SIGKILL");
      } catch (err) {}
    }
    llamaEmbeddingChildProcess = null;
    logLlama("Serveur llama-server d'embedding arrêté.");
  }
  // Clear any zombie process on port 5001
  await killProcessOnPort(5001);
}

// Hook termination signals to dispose background servers cleanly
process.on("exit", () => {
  if (llamaChildProcess) {
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /pid ${llamaChildProcess.pid} /f /t`);
      } else {
        process.kill(-llamaChildProcess.pid);
      }
    } catch (e) {}
  }
  if (llamaEmbeddingChildProcess) {
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /pid ${llamaEmbeddingChildProcess.pid} /f /t`);
      } else {
        process.kill(-llamaEmbeddingChildProcess.pid);
      }
    } catch (e) {}
  }
});

export async function killAllLlamaServers() {
  console.log("[Launch] Nettoyage et arrêt de tous les processus llama-server existants sur la machine...");
  try {
    if (process.platform === "win32") {
      try {
        execSync("taskkill /f /im llama-server.exe", { stdio: "ignore" });
        console.log("[Launch] Arrêt planifié des processus Windows llama-server.exe terminé.");
      } catch (err) {
        // Ignored under windows when no process is running
      }
    } else {
      try {
        execSync("killall -9 llama-server", { stdio: "ignore" });
        console.log("[Launch] Arrêt planifié des processus Unix llama-server terminé.");
      } catch (err) {
        try {
          execSync("pkill -9 -f llama-server", { stdio: "ignore" });
          console.log("[Launch] Arrêt alternatif pkill de llama-server terminé.");
        } catch (e) {}
      }
    }
  } catch (error: any) {
    console.error("[Launch] Exception lors de la commande globale de suppression des processus llama-server:", error.message || error);
  }
  // Libérer également les ports 5000 et 5001 au cas où des instances y résisteraient
  try {
    await killProcessOnPort(5000);
    await killProcessOnPort(5001);
  } catch(e) {}
}

export function isX86Binary(filePath: string): { isX86: boolean; reason: string } {
  try {
    if (!fs.existsSync(filePath)) {
      return { isX86: false, reason: "Fichier inexistant" };
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 64) {
      return { isX86: false, reason: "Fichier de taille invalide ou incomplet" };
    }

    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(1024);
    fs.readSync(fd, buffer, 0, 1024, 0);
    fs.closeSync(fd);

    // Signature Windows PE (MZ)
    if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
      const peOffset = buffer.readUInt32LE(0x3c);
      if (peOffset + 24 <= buffer.length) {
        if (buffer[peOffset] === 0x50 && buffer[peOffset + 1] === 0x45 && buffer[peOffset + 2] === 0x00 && buffer[peOffset + 3] === 0x00) {
          const machine = buffer.readUInt16LE(peOffset + 4);
          if (machine === 0x8664) {
            return { isX86: true, reason: "Windows x86-64 (AMD64 / Intel 64-bit)" };
          }
          if (machine === 0x014c) {
            return { isX86: true, reason: "Windows x86 (Intel 32-bit)" };
          }
          if (machine === 0xaa64) {
            return { isX86: false, reason: "Windows ARM64 (Incompatible avec l'architecture x86)" };
          }
          return { isX86: false, reason: `Windows PE code machine 0x${machine.toString(16)} non-x86` };
        }
      }
      return { isX86: false, reason: "Windows PE malformé ou signature PE introuvable" };
    }

    // Signature Linux ELF
    if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
      const isMSB = buffer[5] === 2;
      const machineCode = isMSB ? buffer.readUInt16BE(0x12) : buffer.readUInt16LE(0x12);
      if (machineCode === 0x3e || machineCode === 0x03) {
        return { isX86: true, reason: `Linux ELF x86/x64 (code machine: 0x${machineCode.toString(16)})` };
      }
      if (machineCode === 0xb7) {
        return { isX86: false, reason: "Linux ELF ARM64 (AArch64) - Non-x86" };
      }
      return { isX86: false, reason: `Linux ELF code machine 0x${machineCode.toString(16)} non-x86` };
    }

    // Signature macOS Mach-O
    const magic = buffer.readUInt32BE(0);
    const magicLE = buffer.readUInt32LE(0);
    if (magicLE === 0xfeedfacf || magicLE === 0xfeedface || magic === 0xfeedfacf || magic === 0xfeedface) {
      const cpuType = magicLE === 0xfeedfacf || magicLE === 0xfeedface ? buffer.readInt32LE(4) : buffer.readInt32BE(4);
      const cleanCpuType = cpuType & 0xffffff;
      if (cleanCpuType === 7) {
        return { isX86: true, reason: "macOS Mach-O x86/x64" };
      }
      if (cleanCpuType === 12) {
        return { isX86: false, reason: "macOS Mach-O ARM64 (Apple Silicon) - Non-x86" };
      }
      return { isX86: false, reason: `macOS Mach-O CPU type: ${cleanCpuType} non-x86` };
    } else if (magic === 0xcafebabe || magicLE === 0xcafebabe) {
      return { isX86: true, reason: "macOS Mach-O Universel/Multiarch (contient potentiellement du x86_64)" };
    }

    // Script wrapper shell bash
    const headText = buffer.toString("utf8", 0, 100);
    if (headText.startsWith("#!")) {
      return { isX86: true, reason: "Script Shell wrapper" };
    }

    return { isX86: false, reason: "Type de fichier exécutable inconnu" };
  } catch (error: any) {
    return { isX86: false, reason: `Erreur d'analyse d'architecture : ${error.message}` };
  }
}

async function ensureLlamaEmbeddingServerRunning(config?: any, isRetry = false): Promise<boolean> {
  if (llamaEmbeddingChildProcess) {
    return true; // Already running
  }
  
  // Clean up any existing process on port 5001 before starting
  await stopLlamaEmbeddingServer();
  
  let targetModel = config?.embeddingModelPath || currentEmbeddingModelPath;
  const modelsDir = path.join(process.cwd(), "data", "models");
  
  if (!targetModel) {
    const defaultModelPath = path.join(modelsDir, "Qwen3-VL-Embedding-2B.Q4_K_M.gguf");
    if (fs.existsSync(defaultModelPath)) {
      targetModel = defaultModelPath;
    } else if (fs.existsSync(modelsDir)) {
      const gFiles = await glob("*.gguf", { cwd: modelsDir });
      if (gFiles.length > 0) {
        // Try to find Qwen3-VL-Embedding-2B.Q4_K_M.gguf inside existing files or similar
        const qwenMatch = gFiles.find(f => f.toLowerCase() === "qwen3-vl-embedding-2b.q4_k_m.gguf");
        // Try to find a file containing 'embed', 'nomic', 'bge', 'minilm', 'qwen', 'vl', 'qwen3', or 'mxbai'
        const embedMatch = qwenMatch || gFiles.find(f => {
          const lf = f.toLowerCase();
          return lf.includes("embed") || lf.includes("nomic") || lf.includes("bge") || lf.includes("minilm") || lf.includes("qwen") || lf.includes("vl") || lf.includes("qwen3") || lf.includes("mxbai");
        });
        if (embedMatch) {
          targetModel = path.join(modelsDir, embedMatch);
        } else {
          // Fallback to the first available model to keep embedding always in memory
          targetModel = path.join(modelsDir, gFiles[0]);
        }
      }
    }
  }

  if (!targetModel || !fs.existsSync(targetModel)) {
    console.info("[EnsureEmbeddingLlama] Aucun modèle disponible pour le serveur d'embedding.");
    return false;
  }

  const flashAttn = config?.useFlashAttention !== false;

  console.log(`[EnsureEmbeddingLlama] Auto-running embedding llama-server on port 5001 with model: ${targetModel} (acceleration: cpu)`);
  
  const isWindows = process.platform === "win32";
  const ext = isWindows ? ".exe" : "";
  const binDir = path.join(process.cwd(), "data", "bin");
  let binaryPath = path.join(binDir, "cpu", "llama-server" + ext);

  if (!fs.existsSync(binaryPath)) {
    const legacyPath = path.join(binDir, "llama-server" + ext);
    if (fs.existsSync(legacyPath)) {
      binaryPath = legacyPath;
    } else {
      binaryPath = "llama-server" + ext; // Fallback to PATH environment
    }
  }

  // Check if target file actually exists on filesystem when using dedicated directories
  const isPathFallback = !binaryPath.includes(path.sep);
  const exists = isPathFallback || (fs.existsSync(binaryPath) && fs.statSync(binaryPath).isFile());
  if (!exists) {
    console.warn(`[EnsureEmbeddingLlama] Le binaire llama-server d'embedding est introuvable (chemin résolu: ${binaryPath}). ` +
                 `Veuillez d'abord télécharger les binaires depuis le panneau d'administration de l'application.`);
    return false;
  }

  // Vérification de l'architecture x86/x64
  if (!isPathFallback) {
    const archCheck = isX86Binary(binaryPath);
    if (!archCheck.isX86) {
      console.warn(`[EnsureEmbeddingLlama] [Architecture Warning] Le binaire d'embedding ne semble pas être compatible x86/x64 (${archCheck.reason}) ! L'exécution risque de planter.`);
    } else {
      console.log(`[EnsureEmbeddingLlama] [Architecture Validated] Le binaire d'embedding est de type ${archCheck.reason}`);
    }
  }

  const spawnCwd = binaryPath.includes(path.sep) ? path.dirname(binaryPath) : process.cwd();

  const args = [
    "-m", targetModel,
    "--port", "5001",
    "--host", "127.0.0.1",
    "--embedding",
    "--pooling", "mean",
    "-c", "8192", // Set context size to 8192 as requested
    "-b", "2048", // Set logical batch size to 2048
    "-ub", "2048" // Set physical batch size to 2048 to avoid memory issues
  ];

  args.push("-ctk", "q4_0");
  args.push("-ctv", "q4_0");

  if (flashAttn) {
    args.push("-fa", "on");
  } else {
    args.push("-fa", "off");
  }

  args.push("-ngl", "0"); // Strictly CPU only for standard embedding model processing

  let hasExited = false;
  let exitCodeReceived: number | null = null;

  try {
    const child = spawn(binaryPath, args, {
      detached: true,
      cwd: spawnCwd,
      env: {
        ...process.env,
        GGML_VULKAN_DEVICE: "0"
      }
    });

    llamaEmbeddingChildProcess = child;
    currentEmbeddingModelPath = targetModel;

    child.stdout.on("data", (data: any) => {
      logLlama(`[Embedding-5001] ${data.toString()}`);
    });

    child.stderr.on("data", (data: any) => {
      logLlama(`[Embedding-5001] ${data.toString()}`);
    });

    child.on("close", (code: number) => {
      logLlama(`Processus llama-server d'embedding arrêté (code: ${code})`);
      hasExited = true;
      exitCodeReceived = code;
      if (llamaEmbeddingChildProcess === child) {
        llamaEmbeddingChildProcess = null;
      }
    });

    child.unref();

    // Probe wait to ensure port 5001 is ready and listening before returning
    logLlama("[EnsureEmbeddingLlama] Serveur d'embedding en cours de démarrage sur le port 5001...");
    let started = false;
    for (let i = 0; i < 30; i++) {
      if (hasExited) {
        break;
      }
      try {
        const check = await fetch("http://127.0.0.1:5001/health").catch(() => null);
        if (check && check.ok) {
          logLlama("[EnsureEmbeddingLlama] Le serveur d'embedding est prêt (5001) et répond à /health.");
          started = true;
          break;
        }
      } catch(e) {}
      await new Promise(r => setTimeout(r, 400));
    }

    if (!started) {
      console.warn(`[EnsureEmbeddingLlama] Failed to start embedding server on cpu. hasExited=${hasExited}, code=${exitCodeReceived}`);
      try {
        if (llamaEmbeddingChildProcess === child) {
          llamaEmbeddingChildProcess = null;
        }
        child.kill();
      } catch (e) {}
      
      return false;
    }
    return true;
  } catch (err: any) {
    let extraTip = "";
    if (isWindows) {
      extraTip = "\n[Aide Windows] Si l'erreur est 'spawn UNKNOWN', vérifiez que :\n" +
                 "1. Vos binaires (dans data/bin/) ne sont pas bloqués ou supprimés par votre Antivirus (fréquent avec les nouveaux téléchargements de llama-server.exe).\n" +
                 "2. Vous avez bien téléchargé les binaires Windows (64-bit) correspondant à l'architecture de votre PC.\n" +
                 "3. Le fichier n'est pas corrompu. Essayez d'exécuter directement le fichier 'data/bin/cpu/llama-server.exe' dans un terminal (CMD/Powershell) pour voir le message d'erreur d'origine de Windows.";
    }
    console.error(`[EnsureEmbeddingLlama] Failed to auto-start embedding llama-server: ${err.message}${extraTip}`);
    return false;
  }
}

async function spawnLlamaServerAttempt(modelPath: string, type: string, flashAttn: boolean): Promise<boolean> {
  const isWindows = process.platform === "win32";
  const ext = isWindows ? ".exe" : "";
  const binDir = path.join(process.cwd(), "data", "bin");
  let binaryPath = path.join(binDir, type, "llama-server" + ext);

  // Fallback to whichever is available or default binary if selected acceleration is missing
  if (!fs.existsSync(binaryPath)) {
    logLlama(`Avertissement : Le binaire spécifié (${binaryPath}) est introuvable. Recherche d'un binaire de repli...`);
    const fallbackCpu = path.join(binDir, "cpu", "llama-server" + ext);
    const fallbackVulkan = path.join(binDir, "vulkan", "llama-server" + ext);
    const fallbackCuda = path.join(binDir, "cuda", "llama-server" + ext);
    
    // Legacy fallback references
    const legacyCpu = path.join(binDir, "llama-server" + ext);
    const legacyVulkan = path.join(binDir, "llama-server-vulkan" + ext);
    const legacyCuda = path.join(binDir, "llama-server-cuda" + ext);

    if (type === "vulkan") {
      if (fs.existsSync(fallbackVulkan)) {
        binaryPath = fallbackVulkan;
      } else if (fs.existsSync(legacyVulkan)) {
        binaryPath = legacyVulkan;
      } else if (fs.existsSync(fallbackCpu)) {
        binaryPath = fallbackCpu; type = "cpu";
      } else if (fs.existsSync(legacyCpu)) {
        binaryPath = legacyCpu; type = "cpu";
      }
    } else if (type === "cuda") {
      if (fs.existsSync(fallbackCuda)) {
        binaryPath = fallbackCuda;
      } else if (fs.existsSync(legacyCuda)) {
        binaryPath = legacyCuda;
      } else if (fs.existsSync(fallbackCpu)) {
        binaryPath = fallbackCpu; type = "cpu";
      } else if (fs.existsSync(legacyCpu)) {
        binaryPath = legacyCpu; type = "cpu";
      }
    } else {
      if (fs.existsSync(fallbackCpu)) {
        binaryPath = fallbackCpu;
      } else if (fs.existsSync(legacyCpu)) {
        binaryPath = legacyCpu;
      }
    }

    if (!fs.existsSync(binaryPath)) {
      if (fs.existsSync(fallbackCpu)) {
        binaryPath = fallbackCpu;
        type = "cpu";
      } else if (fs.existsSync(legacyCpu)) {
        binaryPath = legacyCpu;
        type = "cpu";
      } else if (fs.existsSync(fallbackVulkan)) {
        binaryPath = fallbackVulkan;
        type = "vulkan";
      } else if (fs.existsSync(legacyVulkan)) {
        binaryPath = legacyVulkan;
        type = "vulkan";
      } else if (fs.existsSync(fallbackCuda)) {
        binaryPath = fallbackCuda;
        type = "cuda";
      } else if (fs.existsSync(legacyCuda)) {
        binaryPath = legacyCuda;
        type = "cuda";
      } else {
        binaryPath = "llama-server" + ext; // System path fallback
      }
    }
  }

  // Check if target file actually exists on filesystem when using dedicated directories
  const isPathFallback = !binaryPath.includes(path.sep);
  const exists = isPathFallback || (fs.existsSync(binaryPath) && fs.statSync(binaryPath).isFile());
  if (!exists) {
    logLlama(`[SpawnAttempt] Impossible de lancer llama-server car le fichier est introuvable (chemin résolu: ${binaryPath}). Veuillez d'abord le télécharger.`);
    return false;
  }

  // Vérification de l'architecture x86/x64
  if (!isPathFallback) {
    const archCheck = isX86Binary(binaryPath);
    if (!archCheck.isX86) {
      logLlama(`[SpawnAttempt] [Architecture Warning] Le binaire llama-server ne semble pas être compatible x86/x64 (${archCheck.reason}) !`);
    } else {
      logLlama(`[SpawnAttempt] [Architecture Validated] Le binaire llama-server est de type ${archCheck.reason}.`);
    }
  }

  const spawnCwd = binaryPath.includes(path.sep) ? path.dirname(binaryPath) : process.cwd();

  logLlama(`[SpawnAttempt] Démarrage de llama-server avec ${binaryPath} (accélération: ${type})...`);
  
  const args = [
    "-m", modelPath,
    "--port", "5000",
    "--host", "127.0.0.1",
    "-c", "8192", 
    "--mmap",
    "--keep", "1024"
  ];

  args.push("-ctk", "q4_0");
  args.push("-ctv", "q4_0");

  if (flashAttn !== false) {
    args.push("-fa", "on");
  } else {
    args.push("-fa", "off");
  }

  // GPU offload layers
  if (type === "vulkan" || type === "cuda") {
    args.push("-ngl", "99");
  } else {
    args.push("-ngl", "0");
  }

  const modelDirName = path.dirname(modelPath);
  const modelBaseName = path.basename(modelPath, path.extname(modelPath));
  const possibleProjector = path.join(modelDirName, `${modelBaseName}.projector.gguf`);
  const possibleClips = [
    possibleProjector,
    path.join(modelDirName, "mmproj.gguf"),
    path.join(modelDirName, "mmproj-model-f16.gguf")
  ];
  
  for (const proj of possibleClips) {
    if (fs.existsSync(proj)) {
      logLlama(`Projecteur multimodal détecté et connecté: ${proj}`);
      args.push("--mmproj", proj);
      break;
    }
  }

  logLlama(`Arguments: ${args.join(" ")}`);

  let hasExited = false;
  let exitCode: number | null = null;

  try {
    const child = spawn(binaryPath, args, {
      detached: true,
      cwd: spawnCwd,
      env: {
        ...process.env,
        GGML_VULKAN_DEVICE: "0",
        GGML_CUDA_ENABLE_UNIFIED_MEMORY: "1",
        GGML_VULKAN_UNIFIED_MEMORY: "1"
      }
    });

    llamaChildProcess = child;
    currentModelPath = modelPath;
    currentAcceleration = type;

    child.stdout.on("data", (data: any) => {
      logLlama(data.toString());
    });

    child.stderr.on("data", (data: any) => {
      logLlama(data.toString());
    });

    child.on("close", (code: number) => {
      logLlama(`Processus llama-server arrêté (code: ${code})`);
      hasExited = true;
      exitCode = code;
      if (llamaChildProcess === child) {
        llamaChildProcess = null;
      }
    });

    child.unref();

    // Probe wait to ensure port 5000 is ready and listening before returning
    let started = false;
    for (let i = 0; i < 25; i++) {
      if (hasExited) {
        break;
      }
      try {
        const check = await fetch("http://127.0.0.1:5000/health").catch(() => null);
        if (check && check.ok) {
          logLlama(`[SpawnAttempt] Le serveur llama-server est prêt (accélération: ${type}) et répond.`);
          started = true;
          break;
        }
      } catch(e) {}
      await new Promise(r => setTimeout(r, 400));
    }

    if (!started || hasExited) {
      logLlama(`[SpawnAttempt] Échec du démarrage du serveur en mode ${type} (a expiré ou s'est arrêté avec code ${exitCode}).`);
      try {
        if (llamaChildProcess === child) {
          llamaChildProcess = null;
        }
        child.kill("SIGKILL");
      } catch (e) {}
      return false;
    }

    return true;
  } catch (err: any) {
    let extraTip = "";
    if (isWindows) {
      extraTip = "\n[Aide Windows] Si l'erreur est 'spawn UNKNOWN', vérifiez que :\n" +
                 "1. Vos binaires (dans data/bin/) ne sont pas bloqués ou supprimés par votre Antivirus (fréquent avec les nouveaux téléchargements de llama-server.exe).\n" +
                 "2. Vous avez bien téléchargé les binaires Windows (64-bit) correspondant à l'architecture de votre PC.\n" +
                 "3. Le binaire n'est pas corrompu. Essayez d'exécuter directement le fichier 'data/bin/" + type + "/llama-server.exe' dans un terminal (CMD/Powershell) pour voir le message d'erreur d'origine.";
    }
    logLlama(`[SpawnAttempt] Bloc d'erreur lors du lancement: ${err.message}${extraTip}`);
    return false;
  }
}

async function startLlamaServerWithFallback(modelPath: string, preferredAcceleration: string, flashAttn: boolean): Promise<boolean> {
  // Arrêter d'abord le serveur actif s'il y en a un avant de démarrer avec le nouveau modèle
  await stopLlamaServer();

  const sequence: string[] = [];
  
  if (preferredAcceleration === "cuda") {
    sequence.push("cuda");
    sequence.push("vulkan");
    sequence.push("cpu");
  } else if (preferredAcceleration === "vulkan") {
    sequence.push("vulkan");
    sequence.push("cuda");
    sequence.push("cpu");
  } else {
    sequence.push("cpu");
    sequence.push("vulkan");
    sequence.push("cuda");
  }

  for (const mode of sequence) {
    logLlama(`[Resilience] Tentative de démarrage du modèle avec acceleration: ${mode}...`);
    const success = await spawnLlamaServerAttempt(modelPath, mode, flashAttn);
    if (success) {
      logLlama(`[Resilience] Succès de démarrage en mode ${mode} !`);
      return true;
    }
  }

  logLlama(`[Resilience] ÉCHEC CRITIQUE : Impossible de démarrer llama-server (tous les modes d'accélération ont échoué).`);
  return false;
}

async function ensureLlamaServerRunning(config?: any) {
  // Always trigger the embedding server in parallel or beforehand to keep it running
  await ensureLlamaEmbeddingServerRunning(config);

  if (llamaChildProcess) {
    try {
      const check = await fetch("http://127.0.0.1:5000/health").catch(() => null);
      if (check && check.ok) {
        return true; // Already running and responding perfectly
      }
    } catch(e) {}
    
    logLlama("[EnsureLlama] Le serveur est enregistré comme actif mais ne répond pas à /health. Redémarrage...");
    await stopLlamaServer();
  }
  
  let targetModel = config?.model || currentModelPath;
  const modelsDir = path.join(process.cwd(), "data", "models");
  
  if (!targetModel) {
    if (fs.existsSync(modelsDir)) {
      const gFiles = await glob("*.gguf", { cwd: modelsDir });
      if (gFiles.length > 0) {
        targetModel = path.join(modelsDir, gFiles[0]);
      }
    }
  }

  if (!targetModel || !fs.existsSync(targetModel)) {
    console.warn("[EnsureLlama] No model file found. Cannot auto-start llama-server.");
    return false;
  }

  let type = config?.acceleration;
  if (!type) {
    if (config?.useVulkan) {
      type = "vulkan";
    } else if (config?.useCuda) {
      type = "cuda";
    } else {
      type = currentAcceleration || "cpu";
    }
  }
  const flashAttn = config?.useFlashAttention !== false;

  console.log(`[EnsureLlama] Auto-starting llama-server with model: ${targetModel} (acceleration preference: ${type})`);

  return await startLlamaServerWithFallback(targetModel, type, flashAttn);
}

// Helper to download streams with progress tracking
async function downloadFile(url: string, destPath: string, progressRef: any) {
  progressRef.status = "downloading";
  progressRef.progress = 0;
  progressRef.total = 0;
  progressRef.current = 0;
  progressRef.error = null;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Erreur HTTP: ${res.status} ${res.statusText}`);
    }
    
    const totalBytes = parseInt(res.headers.get("content-length") || "0", 10);
    progressRef.total = totalBytes;

    const fileStream = fs.createWriteStream(destPath);
    let downloadedBytes = 0;

    return new Promise<void>((resolve, reject) => {
      res.body.on("data", (chunk) => {
        downloadedBytes += chunk.length;
        progressRef.current = downloadedBytes;
        progressRef.progress = totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
      });

      res.body.pipe(fileStream);

      fileStream.on("finish", () => {
        fileStream.close();
        progressRef.status = "completed";
        progressRef.progress = 100;
        resolve();
      });

      fileStream.on("error", (err) => {
        fileStream.close();
        fs.unlink(destPath, () => {});
        progressRef.status = "error";
        progressRef.error = err.message;
        reject(err);
      });
      
      res.body.on("error", (err) => {
        fileStream.close();
        fs.unlink(destPath, () => {});
        progressRef.status = "error";
        progressRef.error = err.message;
        reject(err);
      });
    });
  } catch (err: any) {
    progressRef.status = "error";
    progressRef.error = err.message;
    throw err;
  }
}

async function startServer() {
  console.log("[Server] Starting Professeur IA Server...");

  // Au lancement de l'application, tuer tous les processus llama-server existants
  try {
    await killAllLlamaServers();
  } catch (err: any) {
    console.error("[Startup] Erreur lors du nettoyage initial des processus llama-server:", err.message || err);
  }

  // Vérifier si les binaires existants dans 'data/bin' sont bien de type x86/x64
  try {
    const binDir = path.join(process.cwd(), "data", "bin");
    if (fs.existsSync(binDir)) {
      console.log("[Startup] Vérification de l'architecture des binaires existants dans 'data/bin'...");
      const findBinariesAndVerify = (dir: string) => {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            findBinariesAndVerify(fullPath);
          } else if (file.toLowerCase().startsWith("llama-server")) {
            const archCheck = isX86Binary(fullPath);
            if (archCheck.isX86) {
              console.log(`[Startup-ArchitectureCheck] [OK] Binaire x86/x64 validé : ${path.relative(process.cwd(), fullPath)} (${archCheck.reason})`);
            } else {
              console.warn(`[Startup-ArchitectureCheck] [WARNING] Binaire non-compatible x86 détecté : ${path.relative(process.cwd(), fullPath)} ! Raison : ${archCheck.reason}`);
            }
          }
        }
      };
      findBinariesAndVerify(binDir);
    } else {
      console.log("[Startup] Dossier 'data/bin' introuvable. Aucun binaire local à vérifier pour le moment.");
    }
  } catch (err: any) {
    console.error("[Startup] Échec de la vérification initiale de l'architecture des binaires :", err.message || err);
  }
  
  const app = express();
  const PORT = 3000;

  let db: lancedb.Connection | null = null;
  let table: lancedb.Table | null = null;

  app.use(express.json());

  app.use((req, res, next) => {
    // Skip progress routes from heavy logging
    if (!req.url.includes("/progress") && !req.url.includes("/status")) {
      console.log(`[Server] ${req.method} ${req.url}`);
    }
    next();
  });

  let scrapeProgress = {
    currentUrl: "",
    progress: 0,
    totalUrls: 0,
    completedUrls: 0,
    status: "idle" as "idle" | "scraping" | "completed" | "error",
    error: null as string | null
  };

  app.get("/api/scrape/progress", (req, res) => {
    res.json(scrapeProgress);
  });

  // Helper function to split text into chunks under 200 characters, respecting sentence boundaries
  function splitTextIntoChunks(text: string, maxChunkLength: number = 195): string[] {
    if (text.length <= maxChunkLength) {
      return [text];
    }

    const chunks: string[] = [];
    let currentChunk = '';
    const sentences = text.split(/(?<=[.!?])\s+/);

    for (const sentence of sentences) {
      if (sentence.length > maxChunkLength) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }

        const phrases = sentence.split(/(?<=[,;])\s+/);
        for (const phrase of phrases) {
          if (phrase.length > maxChunkLength) {
            if (currentChunk) {
              chunks.push(currentChunk.trim());
              currentChunk = '';
            }
            const words = phrase.split(/\s+/);
            for (const word of words) {
              if ((currentChunk + ' ' + word).length > maxChunkLength) {
                if (currentChunk) {
                  chunks.push(currentChunk.trim());
                }
                currentChunk = word;
              } else {
                currentChunk += (currentChunk ? ' ' : '') + word;
              }
            }
          } else {
            if ((currentChunk + ' ' + phrase).length > maxChunkLength) {
              if (currentChunk) {
                chunks.push(currentChunk.trim());
              }
              currentChunk = phrase;
            } else {
              currentChunk += (currentChunk ? ' ' : '') + phrase;
            }
          }
        }
      } else {
        if ((currentChunk + ' ' + sentence).length > maxChunkLength) {
          if (currentChunk) {
            chunks.push(currentChunk.trim());
          }
          currentChunk = sentence;
        } else {
          currentChunk += (currentChunk ? ' ' : '') + sentence;
        }
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  app.get("/api/tts", async (req, res) => {
    const text = req.query.text as string;
    const lang = (req.query.lang as string) || 'fr';
    
    if (!text) return res.status(400).json({ error: "Text is required" });

    try {
      const textChunks = splitTextIntoChunks(text, 195);
      const audioBuffers: Buffer[] = [];
      
      for (let i = 0; i < textChunks.length; i++) {
        const chunk = textChunks[i];
        try {
          const audioUrl = gtts.getAudioUrl(chunk, { lang, slow: false, host: 'https://translate.google.com' });
          const audioResponse = await fetch(audioUrl);
          if (!audioResponse.ok) {
            throw new Error(`Failed to fetch audio chunk: ${audioResponse.statusText}`);
          }
          const arrayBuffer = await audioResponse.arrayBuffer();
          audioBuffers.push(Buffer.from(arrayBuffer));
        } catch (err) {
          console.error(`[TTS] Error processing chunk ${i + 1}:`, err);
          throw err;
        }
      }
      
      const finalBuffer = Buffer.concat(audioBuffers);
      res.set({
        'Content-Type': 'audio/mpeg',
        'Content-Length': finalBuffer.length
      });
      res.send(finalBuffer);
    } catch (error) {
      console.error("[TTS] Google TTS generation error:", error);
      res.status(500).json({ error: "TTS generation failed", details: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/scrape/sync", async (req, res) => {
    const { urls, settings } = req.body;
    
    if (!urls || !Array.isArray(urls)) {
      return res.status(400).json({ error: "Invalid URLs list" });
    }

    if (scrapeProgress.status === "scraping") {
      return res.status(400).json({ error: "Scraping already in progress" });
    }

    scrapeProgress = {
      currentUrl: "",
      progress: 0,
      totalUrls: urls.length,
      completedUrls: 0,
      status: "scraping",
      error: null
    };

    res.json({ status: "started" });

    (async () => {
      try {
        for (const url of urls) {
          scrapeProgress.currentUrl = url;
          scrapeProgress.progress = 0;

          try {
            const alreadyIndexed = await isUrlIndexed(url);
            if (alreadyIndexed) {
              scrapeProgress.completedUrls++;
              continue;
            }

            const scraped = await fetchAndClean(url);
            await indexWebPage(
              url,
              scraped.title,
              scraped.markdown,
              scraped.siteName,
              scraped.images,
              settings,
              (p) => {
                scrapeProgress.progress = p;
              }
            );
            scrapeProgress.completedUrls++;
          } catch (err: any) {
            console.error(`[Scraper] Error processing ${url}:`, err);
          }
        }
        scrapeProgress.status = "completed";
        scrapeProgress.currentUrl = "";
        scrapeProgress.progress = 100;
      } catch (err: any) {
        scrapeProgress.status = "error";
        scrapeProgress.error = err.message;
      }
    })();
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", engine: "Llama.cpp Server", dbConnected: !!db, llamaRunning: !!llamaChildProcess });
  });

  app.get("/api/documents", async (req, res) => {
    const { documentsPath } = req.query;
    if (!documentsPath) return res.status(400).json({ error: "Path is required" });
    const normalizedPath = path.resolve(documentsPath as string);
    if (!fs.existsSync(normalizedPath)) return res.status(400).json({ error: "Path not found" });
    try {
      const files = await glob("**/*.pdf", { cwd: normalizedPath, absolute: true });
      res.json({ files: files.map(f => ({ name: path.basename(f), path: f })) });
    } catch (e) {
      res.status(500).json({ error: "Failed to list documents" });
    }
  });

  app.get("/api/documents/view", (req, res) => {
    const { filePath } = req.query;
    if (!filePath) return res.status(400).json({ error: "File path is required" });
    const normalizedPath = path.resolve(filePath as string);
    if (!fs.existsSync(normalizedPath)) return res.status(404).json({ error: "File not found" });
    res.sendFile(normalizedPath);
  });

  app.get("/api/fs/browse", async (req, res) => {
    const { folderPath } = req.query;
    let targetPath = process.cwd();
    if (folderPath) {
      targetPath = path.resolve(folderPath as string);
    }
    
    try {
      if (!fs.existsSync(targetPath)) {
        return res.status(404).json({ error: "Dossier non trouvé" });
      }
      const stat = fs.statSync(targetPath);
      if (!stat.isDirectory()) {
         return res.status(400).json({ error: "Le chemin spécifié n'est pas un dossier" });
      }

      const items = await fs.promises.readdir(targetPath, { withFileTypes: true });
      const directories = items
        .filter(item => item.isDirectory() && !item.name.startsWith("."))
        .map(item => ({
          name: item.name,
          path: path.join(targetPath, item.name)
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      res.json({
        currentPath: targetPath,
        parentPath: targetPath === path.resolve("/") ? null : path.dirname(targetPath),
        directories
      });
    } catch (e: any) {
      res.status(500).json({ error: "Erreur de lecture du dossier : " + e.message });
    }
  });

  app.get("/api/annotations", async (req, res) => {
    const { documentId } = req.query;
    if (!db) return res.status(500).json({ error: "DB not connected" });
    try {
      const annTable = await db.openTable("annotations").catch(() => null);
      if (!annTable) return res.json({ annotations: [] });
      const results = await annTable.query().where(`documentId = '${documentId}'`).toArray();
      res.json({ annotations: results });
    } catch (e) {
      res.status(500).json({ error: "Failed to load annotations" });
    }
  });

  app.post("/api/annotations", async (req, res) => {
    const { documentId, annotation } = req.body;
    if (!db) return res.status(500).json({ error: "DB not connected" });
    try {
      let annTable;
      try {
        annTable = await db.openTable("annotations");
      } catch (e) {
        annTable = await db.createTable("annotations", [{ id: Date.now(), documentId: "", type: "", content: "", page: 0, x: 0, y: 0, width: 0, height: 0, color: "" }]);
        await annTable.delete("documentId = ''");
      }
      await annTable.add([{ ...annotation, documentId, id: Date.now() }]);
      res.json({ status: "success" });
    } catch (e) {
      res.status(500).json({ error: "Failed to save annotation" });
    }
  });

  async function ensureVectorIndexOnTable(tableToIndex: lancedb.Table) {
    try {
      const rowCount = await tableToIndex.countRows();
      console.log(`[VectorDB-Indexation] Creating/Updating HNSW-SQ vector index for ${rowCount} rows...`);
      await tableToIndex.createIndex("vector", {
        config: lancedb.Index.hnswSq(),
        replace: true
      });
      console.log(`[VectorDB-Indexation] Vector index (HNSW-SQ) created/updated successfully for ${rowCount} rows.`);
    } catch (err: any) {
      console.log("[VectorDB-Indexation] Vector index creation skipped or failed using HNSW-SQ:", err.message || err);
    }
  }

  app.post("/api/purge", async (req, res) => {
    if (!db) return res.status(500).json({ error: "Database not connected" });
    try {
      const tableNames = await db.tableNames();
      for (const name of tableNames) {
        await db.dropTable(name);
      }
      
      const dim = await resolveEmbeddingDimension();
      const initialData = [
        { id: "init_1", vector: Array(dim).fill(0.1), content: "La photosynthèse est le processus par lequel les plantes vertes synthétisent des matières organiques grâce à l'énergie lumineuse.", source: "Biologie 3ème", type: 'chunk', hash: 'initial', chunk_hash: 'initial_1' },
        { id: "init_2", vector: Array(dim).fill(0.2), content: "Le théorème de Pythagore : dans un triangle rectangle, le carré de l'hypoténuse est égal à la somme des carrés des deux autres côtés.", source: "Maths 4ème", type: 'chunk', hash: 'initial', chunk_hash: 'initial_2' },
        { id: "init_3", vector: Array(dim).fill(0.3), content: "La Révolution française commence en 1789 avec la prise de la Bastille.", source: "Histoire 4ème", type: 'chunk', hash: 'initial', chunk_hash: 'initial_3' }
      ];
      table = await db.createTable("manuels", initialData, { schema: getManuelsSchema(dim) });
      await ensureVectorIndexOnTable(table);

      const cacheDir = path.join(process.cwd(), 'data', 'image_cache');
      if (fs.existsSync(cacheDir)) {
        fs.rmSync(cacheDir, { recursive: true, force: true });
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      res.json({ status: "success" });
    } catch (error) {
      console.error("[Server] Purge Error:", error);
      res.status(500).json({ error: "Failed to purge database" });
    }
  });

  // Initialize LanceDB in background
  const dbPath = path.join(process.cwd(), "data", "lancedb");
  (async () => {
    try {
      if (!fs.existsSync(path.dirname(dbPath))) {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      }
      console.log(`[Server] Connecting to LanceDB at ${dbPath}`);
      db = await lancedb.connect(dbPath);
      console.log("[Server] Connected to LanceDB.");
      
      const dim = await resolveEmbeddingDimension();
      console.log(`[Server] Embedding dimension resolved for DB: ${dim}`);
      
      try {
        table = await db.openTable("manuels");
        console.log("[Server] Opened existing table 'manuels'");
        // Validate vector dimension of the table by doing a mock search
        const dummyVector = Array(dim).fill(0);
        await table.search(dummyVector).limit(1).toArray();
      } catch (e: any) {
        if (e.message?.includes("dimension") || e.message?.includes("schema") || e.message?.includes("Invalid range") || e.message?.includes("Generic memory error")) {
           console.error("[Server] Table 'manuels' needs recreation due to dimension mismatch or corruption. Recreating...");
           try { await db.dropTable("manuels"); } catch(err) {}
        }
        
        console.log(`[Server] Creating new table 'manuels' with dimension: ${dim}`);
        const initialData = [
          { id: "init_1", vector: Array(dim).fill(0.1), content: "La photosynthèse est le processus par lequel les plantes vertes synthétisent des matières organiques grâce à l'énergie lumineuse.", source: "Biologie 3ème", type: 'chunk', hash: 'initial', chunk_hash: 'initial_1' },
          { id: "init_2", vector: Array(dim).fill(0.2), content: "Le théorème de Pythagore : dans un triangle rectangle, le carré de l'hypoténuse est égal à la somme des carrés des deux autres côtés.", source: "Maths 4ème", type: 'chunk', hash: 'initial', chunk_hash: 'initial_2' },
          { id: "init_3", vector: Array(dim).fill(0.3), content: "La Révolution française commence en 1789 avec la prise de la Bastille.", source: "Histoire 4ème", type: 'chunk', hash: 'initial', chunk_hash: 'initial_3' }
        ];
        table = await db.createTable("manuels", initialData, { schema: getManuelsSchema(dim) });
        await ensureVectorIndexOnTable(table);
      }

      // Auto-start the CPU-only embedding server in background so it matches "always in memory" requirement
      console.info("[Server] Auto-starting CPU-only embedding server in background to keep it always in memory...");
      ensureLlamaEmbeddingServerRunning().catch(err => {
        console.error("[Server] Auto-started embedding server background error:", err);
      });
    } catch (dbError) {
      console.error("[Server] Reference DB Connection error:", dbError);
    }
  })();

  // Llama.cpp Controller Endpoints

  app.get("/api/llama/status", (req, res) => {
    const binDir = path.join(process.cwd(), "data", "bin");
    const isWindows = process.platform === "win32";
    const ext = isWindows ? ".exe" : "";
    const cpuExists = fs.existsSync(path.join(binDir, "cpu", "llama-server" + ext)) || fs.existsSync(path.join(binDir, "llama-server" + ext));
    const vulkanExists = fs.existsSync(path.join(binDir, "vulkan", "llama-server" + ext)) || fs.existsSync(path.join(binDir, "llama-server-vulkan" + ext));
    const cudaExists = fs.existsSync(path.join(binDir, "cuda", "llama-server" + ext)) || fs.existsSync(path.join(binDir, "llama-server-cuda" + ext));
    
    res.json({
      running: !!llamaChildProcess,
      modelPath: currentModelPath,
      embeddingRunning: !!llamaEmbeddingChildProcess,
      embeddingModelPath: currentEmbeddingModelPath,
      acceleration: currentAcceleration,
      binaries: {
        cpu: cpuExists,
        vulkan: vulkanExists,
        cuda: cudaExists
      },
      logs: llamaLogs,
      downloadProgress,
      modelDownloadProgress
    });
  });

  app.get("/api/llama/check-updates", async (req, res) => {
    try {
      const response = await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest", {
        headers: { "User-Agent": "ProfIA-LlamaServer-Updater" }
      });
      if (!response.ok) {
        throw new Error(`GitHub API returned: ${response.status} ${response.statusText}`);
      }
      const data = (await response.json()) as any;
      lastBinaryTag = data.tag_name || "b9382";
      res.json({
        latestTag: lastBinaryTag,
        assets: data.assets?.map((a: any) => ({ name: a.name, downloadUrl: a.browser_download_url })) || []
      });
    } catch (err: any) {
      console.error("[LlamaServer] Failed to fetch GitHub updates:", err);
      res.status(500).json({ error: "Failed to fetch update info from GitHub", details: err.message });
    }
  });

  async function getLlamaAssetAndUrl(targetTag: string, type: "cpu" | "vulkan" | "cuda") {
    const isWindows = process.platform === "win32";
    
    if (!isWindows && type === "cuda") {
      throw new Error("L'équipe ggml-org/llama.cpp ne fournit pas de binaire CUDA précompilé pour Linux/Ubuntu. " + 
                      "Veuillez télécharger et utiliser le binaire Vulkan ('vulkan') pour l'accélération GPU sous Linux : " +
                      "il est nativement compatible avec les cartes NVIDIA et fonctionne immédiatement sans dépendance CUDA !");
    }

    // Default guess file names
    let guessedAssetName = "";
    if (isWindows) {
      if (type === "vulkan") {
        guessedAssetName = `llama-${targetTag}-bin-win-vulkan-x64.zip`;
      } else if (type === "cuda") {
        guessedAssetName = `llama-${targetTag}-bin-win-cuda-cu12.2.0-x64.zip`;
      } else {
        guessedAssetName = `llama-${targetTag}-bin-win-llvm-x64.zip`;
      }
    } else {
      if (type === "vulkan") {
        guessedAssetName = `llama-${targetTag}-bin-ubuntu-vulkan-x64.tar.gz`;
      } else if (type === "cuda") {
        guessedAssetName = `llama-${targetTag}-bin-ubuntu-cuda-x64.tar.gz`;
      } else {
        guessedAssetName = `llama-${targetTag}-bin-ubuntu-x64.tar.gz`;
      }
    }
    
    let downloadUrl = `https://github.com/ggml-org/llama.cpp/releases/download/${targetTag}/${guessedAssetName}`;
    let assetName = guessedAssetName;
    let cudartAssetName = "";
    let cudartDownloadUrl = "";

    try {
      const apiTag = targetTag === "latest" ? "latest" : `tags/${targetTag}`;
      const url = `https://api.github.com/repos/ggml-org/llama.cpp/releases/${apiTag}`;
      const res = await fetch(url, { headers: { "User-Agent": "ProfIA-LlamaServer-Updater" } });
      if (res.ok) {
        const data = (await res.json()) as any;
        const assets = data.assets || [];
        
        let found = null;
        if (isWindows) {
          if (type === "vulkan") {
            found = assets.find((a: any) => a.name.includes("bin-win-vulkan") && a.name.endsWith(".zip"));
          } else if (type === "cuda") {
            // Must start with llama- to avoid matching cudart-llama zip as the main binaire
            found = assets.find((a: any) => a.name.includes("bin-win-cuda") && a.name.startsWith("llama-") && a.name.endsWith(".zip"));
            
            // Look for companion cudart DLLs zip as well
            const cudartFound = assets.find((a: any) => a.name.includes("cudart-llama-bin-win-cuda") && a.name.endsWith(".zip"));
            if (cudartFound) {
              cudartAssetName = cudartFound.name;
              cudartDownloadUrl = cudartFound.browser_download_url;
            }
          } else {
            found = assets.find((a: any) => a.name.includes("bin-win-llvm") && a.name.endsWith(".zip"))
                 || assets.find((a: any) => a.name.includes("bin-win-msvc") && a.name.endsWith(".zip"))
                 || assets.find((a: any) => a.name.includes("bin-win-") && a.name.endsWith(".zip") && !a.name.includes("vulkan") && !a.name.includes("cuda"));
          }
        } else {
          if (type === "vulkan") {
            found = assets.find((a: any) => a.name.includes("bin-ubuntu-vulkan") && a.name.endsWith(".tar.gz"));
          } else if (type === "cuda") {
            found = assets.find((a: any) => a.name.includes("bin-ubuntu-cuda") && a.name.endsWith(".tar.gz"));
          } else {
            found = assets.find((a: any) => a.name.includes("bin-ubuntu") && a.name.endsWith(".tar.gz") && !a.name.includes("vulkan") && !a.name.includes("cuda"));
          }
        }
        
        if (found) {
          assetName = found.name;
          downloadUrl = found.browser_download_url;
          console.log(`[LlamaAsset] Match API trouvé : ${assetName}`);
        }
      }
    } catch (err: any) {
      console.warn("[LlamaAsset] Error fetching GitHub release API, using guess suffix:", err.message);
    }
    return { assetName, downloadUrl, cudartAssetName, cudartDownloadUrl };
  }

  function extractArchive(archivePath: string, binDir: string) {
    if (process.platform === "win32") {
      try {
        console.log(`[Extract] PowerShell Expand-Archive : ${archivePath}`);
        execSync(`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${binDir}' -Force"`);
      } catch (err: any) {
        console.warn(`[Extract] PowerShell failed, trying tar: ${err.message}`);
        execSync(`tar -xf "${archivePath}" -C "${binDir}"`);
      }
    } else {
      if (archivePath.endsWith(".zip")) {
        execSync(`unzip -o "${archivePath}" -d "${binDir}"`);
      } else {
        execSync(`tar -xzf "${archivePath}" -C "${binDir}"`);
      }
    }
  }

  app.post("/api/llama/binaries/download", async (req, res) => {
    const { tag, type } = req.body; // type: "cpu" | "vulkan" | "cuda"
    const targetTag = tag || lastBinaryTag;
    const isVulkan = type === "vulkan";
    const isCuda = type === "cuda";
    
    res.json({ status: "started" });

    (async () => {
      try {
        const { assetName, downloadUrl, cudartAssetName, cudartDownloadUrl } = await getLlamaAssetAndUrl(targetTag, type);
        
        logLlama(`Déchargement de ${assetName} depuis github...`);
        const binDir = path.join(process.cwd(), "data", "bin");
        if (!fs.existsSync(binDir)) {
          fs.mkdirSync(binDir, { recursive: true });
        }

        const archiveExt = assetName.endsWith(".zip") ? ".zip" : ".tar.gz";
        const archivePath = path.join(binDir, "tmp" + archiveExt);

        await downloadFile(downloadUrl, archivePath, downloadProgress);
        
        logLlama(`Téléchargement terminé ! Extraction de l'archive ${archiveExt}...`);
        downloadProgress.status = "extracting";
        
        const extractTempDir = path.join(binDir, "extract_temp_" + type + "_" + Date.now());
        if (!fs.existsSync(extractTempDir)) {
          fs.mkdirSync(extractTempDir, { recursive: true });
        }

        extractArchive(archivePath, extractTempDir);

        // Download companion cudart dlls zip if CUDA under Windows is requested
        if (cudartDownloadUrl && cudartAssetName) {
          logLlama(`Téléchargement complémentaire des DLLs CUDA (${cudartAssetName})...`);
          const cudartArchivePath = path.join(binDir, "cudart_tmp.zip");
          await downloadFile(cudartDownloadUrl, cudartArchivePath, downloadProgress);
          logLlama(`DLLs CUDA téléchargées! Extraction dans le dossier temporaire...`);
          extractArchive(cudartArchivePath, extractTempDir);
          if (fs.existsSync(cudartArchivePath)) {
            fs.unlinkSync(cudartArchivePath);
          }
        }

        logLlama("Extraction terminée ! Recherche de l'exécutable llama-server...");

        // Find the newly extracted llama-server inside the temp archive directory recursively
        const matches = await glob("**/llama-server*", { cwd: extractTempDir, absolute: true });
        if (matches.length === 0) {
          throw new Error("L'exécutable llama-server n'a pas été trouvé dans l'archive extraite.");
        }

        const matchedBinaryPath = matches[0];
        const isWindows = process.platform === "win32";
        const ext = isWindows ? ".exe" : "";
        
        // Target subdirectory based on type
        const targetSubDir = path.join(binDir, type);
        logLlama(`Installation du package binaire dans son dossier dédié : ${targetSubDir}...`);
        
        try {
          if (fs.existsSync(targetSubDir)) {
            fs.rmSync(targetSubDir, { recursive: true, force: true });
          }
        } catch (e) {
          logLlama(`Note: Impossible d'effacer le dossier cible (${targetSubDir}). Peut-être que des fichiers sont verrouillés.`);
        }
        
        if (!fs.existsSync(targetSubDir)) {
          fs.mkdirSync(targetSubDir, { recursive: true });
        }

        // Copy everything recursively from the directory where the matched binary resides
        const srcDir = path.dirname(matchedBinaryPath);
        fs.cpSync(srcDir, targetSubDir, { recursive: true, force: true });
        
        // Copy any DLL or runtime shared library files from anywhere in the extraction folder directly to targetSubDir
        const runtimeLibs = await glob("**/*.{dll,so,dylib}", { cwd: extractTempDir, absolute: true });
        for (const lib of runtimeLibs) {
          const destLibPath = path.join(targetSubDir, path.basename(lib));
          if (!fs.existsSync(destLibPath)) {
            fs.copyFileSync(lib, destLibPath);
          }
        }

        // Ensure standard name 'llama-server' (or 'llama-server.exe') is present in the folder
        const mainBinaryInTarget = path.join(targetSubDir, path.basename(matchedBinaryPath));
        const standardBinaryInTarget = path.join(targetSubDir, "llama-server" + ext);
        
        if (mainBinaryInTarget !== standardBinaryInTarget && fs.existsSync(mainBinaryInTarget)) {
          fs.copyFileSync(mainBinaryInTarget, standardBinaryInTarget);
        }

        if (!isWindows) {
          // Grant execution permissions to everything inside targetSubDir that has 'llama-' prefix or similar
          const files = fs.readdirSync(targetSubDir);
          for (const f of files) {
            const fPath = path.join(targetSubDir, f);
            if (fs.statSync(fPath).isFile() && (f.startsWith("llama-") || f === "llama-server")) {
              fs.chmodSync(fPath, 0o755);
            }
          }
        }
        
        // Cleanup temp archive & extracted directories
        if (fs.existsSync(archivePath)) {
          fs.unlinkSync(archivePath);
        }
        try {
          fs.rmSync(extractTempDir, { recursive: true, force: true });
        } catch (e) {}
        
        logLlama(`Le binaire ${type}/llama-server${ext} et ses dépendances sont prêts !`);
        downloadProgress.status = "idle";
      } catch (err: any) {
        logLlama(`Échec de la mise à jour binaire: ${err.message}`);
        downloadProgress.status = "error";
        downloadProgress.error = err.message;
      }
    })();
  });

  app.post("/api/llama/binaries/download-all", async (req, res) => {
    const { tag } = req.body;
    const targetTag = tag || lastBinaryTag;
    
    logLlama("Lancement du téléchargement complet de tous les binaires (CPU, Vulkan, CUDA)...");
    res.json({ status: "started" });

    (async () => {
      try {
        const types = ["cpu", "vulkan", "cuda"] as const;
        for (const type of types) {
          try {
            const isVulkan = type === "vulkan";
            const isCuda = type === "cuda";
            
            const { assetName, downloadUrl, cudartAssetName, cudartDownloadUrl } = await getLlamaAssetAndUrl(targetTag, type);

            logLlama(`Déchargement de ${assetName} (${type.toUpperCase()}) depuis github...`);
            const binDir = path.join(process.cwd(), "data", "bin");
            if (!fs.existsSync(binDir)) {
              fs.mkdirSync(binDir, { recursive: true });
            }

            const archiveExt = assetName.endsWith(".zip") ? ".zip" : ".tar.gz";
            const archivePath = path.join(binDir, `tmp_${type}${archiveExt}`);

            await downloadFile(downloadUrl, archivePath, downloadProgress);
            
            logLlama(`Téléchargement de ${type.toUpperCase()} fini. Extraction de l'archive...`);
            downloadProgress.status = "extracting";
            
            const extractTempDir = path.join(binDir, "extract_temp_" + type + "_" + Date.now());
            if (!fs.existsSync(extractTempDir)) {
              fs.mkdirSync(extractTempDir, { recursive: true });
            }

            extractArchive(archivePath, extractTempDir);

            // Download companion cudart dlls zip if CUDA under Windows is requested
            if (cudartDownloadUrl && cudartAssetName) {
              logLlama(`Téléchargement complémentaire des DLLs CUDA (${cudartAssetName})...`);
              const cudartArchivePath = path.join(binDir, `cudart_tmp_${type}.zip`);
              await downloadFile(cudartDownloadUrl, cudartArchivePath, downloadProgress);
              logLlama(`DLLs CUDA téléchargées! Extraction dans le dossier temporaire...`);
              extractArchive(cudartArchivePath, extractTempDir);
              if (fs.existsSync(cudartArchivePath)) {
                fs.unlinkSync(cudartArchivePath);
              }
            }

            const matches = await glob("**/llama-server*", { cwd: extractTempDir, absolute: true });
            if (matches.length > 0) {
              const matchedBinaryPath = matches[0];
              const isWindows = process.platform === "win32";
              const ext = isWindows ? ".exe" : "";
              
              // Target subdirectory based on type
              const targetSubDir = path.join(binDir, type);
              logLlama(`Installation du package binaire (${type.toUpperCase()}) dans son dossier dédié : ${targetSubDir}...`);
              
              try {
                if (fs.existsSync(targetSubDir)) {
                  fs.rmSync(targetSubDir, { recursive: true, force: true });
                }
              } catch (e) {
                logLlama(`Note: Impossible d'effacer le dossier cible (${targetSubDir}). Peut-être que des fichiers sont verrouillés.`);
              }
              
              if (!fs.existsSync(targetSubDir)) {
                fs.mkdirSync(targetSubDir, { recursive: true });
              }

              // Copy everything recursively from the directory where the matched binary resides
              const srcDir = path.dirname(matchedBinaryPath);
              fs.cpSync(srcDir, targetSubDir, { recursive: true, force: true });
              
              // Copy any DLL or runtime shared library files from anywhere in the extraction folder directly to targetSubDir
              const runtimeLibs = await glob("**/*.{dll,so,dylib}", { cwd: extractTempDir, absolute: true });
              for (const lib of runtimeLibs) {
                const destLibPath = path.join(targetSubDir, path.basename(lib));
                if (!fs.existsSync(destLibPath)) {
                  fs.copyFileSync(lib, destLibPath);
                }
              }

              // Ensure standard name 'llama-server' (or 'llama-server.exe') is present in the folder
              const mainBinaryInTarget = path.join(targetSubDir, path.basename(matchedBinaryPath));
              const standardBinaryInTarget = path.join(targetSubDir, "llama-server" + ext);
              
              if (mainBinaryInTarget !== standardBinaryInTarget && fs.existsSync(mainBinaryInTarget)) {
                fs.copyFileSync(mainBinaryInTarget, standardBinaryInTarget);
              }

              if (!isWindows) {
                // Grant execution permissions to everything inside targetSubDir that has 'llama-' prefix or similar
                const files = fs.readdirSync(targetSubDir);
                for (const f of files) {
                  const fPath = path.join(targetSubDir, f);
                  if (fs.statSync(fPath).isFile() && (f.startsWith("llama-") || f === "llama-server")) {
                    fs.chmodSync(fPath, 0o755);
                  }
                }
              }
              logLlama(`Binaire ${type}/llama-server${ext} et ses dépendances installés.`);
            }
            
            if (fs.existsSync(archivePath)) {
              fs.unlinkSync(archivePath);
            }
            try {
              fs.rmSync(extractTempDir, { recursive: true, force: true });
            } catch (e) {}
          } catch (err: any) {
            logLlama(`Échec de l'installation pour le type ${type}: ${err.message}. Passage au binaire suivant.`);
          }
        }

        logLlama("Installation complète terminée (les binaires compatibles ont été installés).");
        downloadProgress.status = "idle";
      } catch (err: any) {
        logLlama(`Échec lors de l'installation des binaires complets : ${err.message}`);
        downloadProgress.status = "error";
        downloadProgress.error = err.message;
      }
    })();
  });

  app.post("/api/llama/models/download", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "Hugging Face model URL is required." });

    // Deduce file name from URL or generate safe fallback
    let fileName = "";
    try {
      fileName = path.basename(new URL(url).pathname);
    } catch(e) {
      fileName = `model_${Date.now()}.gguf`;
    }
    
    if (!fileName.endsWith(".gguf")) {
      fileName += ".gguf";
    }

    const modelsDir = path.join(process.cwd(), "data", "models");
    if (!fs.existsSync(modelsDir)) {
      fs.mkdirSync(modelsDir, { recursive: true });
    }

    const destPath = path.join(modelsDir, fileName);
    logLlama(`Démarrage du téléchargement du modèle GGUF ${fileName}...`);

    res.json({ status: "started", fileName });

    (async () => {
      try {
        await downloadFile(url, destPath, modelDownloadProgress);
        logLlama(`Le modèle GGUF ${fileName} a été téléchargé avec succès !`);
        modelDownloadProgress.status = "idle";
      } catch (err: any) {
        logLlama(`Erreur lors du téléchargement du modèle: ${err.message}`);
        modelDownloadProgress.status = "error";
        modelDownloadProgress.error = err.message;
      }
    })();
  });

  app.get("/api/llama/models/list", async (req, res) => {
    const modelsDir = path.join(process.cwd(), "data", "models");
    if (!fs.existsSync(modelsDir)) {
      return res.json({ models: [] });
    }

    try {
      const files = await glob("*.gguf", { cwd: modelsDir });
      const list = files.map(file => {
        const fullPath = path.join(modelsDir, file);
        const stats = fs.statSync(fullPath);
        return {
          name: file,
          path: fullPath,
          size: stats.size
        };
      });
      res.json({ models: list });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to list GGUF models", details: err.message });
    }
  });

  app.delete("/api/llama/models/delete", async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "GGUF filename is required" });

    const modelsDir = path.join(process.cwd(), "data", "models");
    const target = path.join(modelsDir, name);
    
    try {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        logLlama(`Modèle supprimé: ${name}`);
        res.json({ status: "deleted" });
      } else {
        res.status(404).json({ error: "Model GGUF file not found" });
      }
    } catch(err: any) {
      res.status(500).json({ error: "Failed to delete GGUF model", details: err.message });
    }
  });

  app.post("/api/llama/start", async (req, res) => {
    const { modelPath, acceleration, flashAttn } = req.body;
    
    if (!modelPath) {
      return res.status(400).json({ error: "Model GGUF path is required to start llama-server." });
    }

    if (!fs.existsSync(modelPath)) {
      return res.status(400).json({ error: `Le fichier modèle GGUF spécifié n'existe pas : ${modelPath}` });
    }

    try {
      const type = acceleration || "cpu";
      const isFlash = flashAttn !== false;
      
      const success = await startLlamaServerWithFallback(modelPath, type, isFlash);
      if (success) {
        res.json({ status: "success", msg: "llama-server started successfully", activeAcceleration: currentAcceleration });
      } else {
        res.status(500).json({ error: "Failed to start llama-server with any acceleration mode. Please check model and logs." });
      }
    } catch (err: any) {
      logLlama(`Échec du lancement du serveur: ${err.message}`);
      res.status(500).json({ error: "Failed to start llama-server", details: err.message });
    }
  });

  app.post("/api/llama/stop", async (req, res) => {
    try {
      await stopLlamaServer();
      res.json({ status: "success", msg: "llama-server stopped" });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to stop llama-server", details: err.message });
    }
  });

  app.post("/api/llama/start-embedding", async (req, res) => {
    let { modelPath, acceleration, flashAttn } = req.body;
    if (modelPath && !fs.existsSync(modelPath)) {
      return res.status(400).json({ error: `Le fichier modèle d'embedding spécifié n'existe pas : ${modelPath}` });
    }

    try {
      await stopLlamaEmbeddingServer();
      const success = await ensureLlamaEmbeddingServerRunning({
        embeddingModelPath: modelPath || undefined,
        useFlashAttention: flashAttn !== false
      });

      if (success) {
        res.json({ status: "success", msg: "Embedding llama-server started on port 5001", modelPath: currentEmbeddingModelPath });
      } else {
        res.status(500).json({ error: "Failed to initialize embedding llama-server on port 5001." });
      }
    } catch (err: any) {
      res.status(500).json({ error: "Failed to start embedding llama-server", details: err.message });
    }
  });

  app.post("/api/llama/stop-embedding", async (req, res) => {
    try {
      await stopLlamaEmbeddingServer();
      res.json({ status: "success", msg: "Embedding llama-server stopped" });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to stop embedding llama-server", details: err.message });
    }
  });

  // End of Llama.cpp Controller Endpoints

  app.get("/api/db/status", async (req, res) => {
    if (!db) {
      return res.json({ connected: false, tables: [] });
    }
    try {
      const tableNames = await db.tableNames();
      const tablesInfo = [];
      for (const name of tableNames) {
        const table = await db.openTable(name);
        const count = await table.countRows();
        tablesInfo.push({ name, count });
      }
      res.json({
        connected: true,
        tables: tablesInfo
      });
    } catch (err: any) {
      res.json({ connected: true, tables: [], error: err.message });
    }
  });

  // LanceDB Indexing & Search Endpoints

  app.post("/api/index/files", async (req, res) => {
    const { documentsPath, llamaConfig } = req.body;
    if (!documentsPath) return res.status(400).json({ error: "Le chemin du dossier est requis." });
    
    if (llamaConfig) {
      await ensureLlamaServerRunning(llamaConfig);
    }

    const normalizedPath = path.resolve(documentsPath);
    if (!fs.existsSync(normalizedPath)) return res.status(400).json({ error: "Le dossier n'existe pas." });
    try {
      const files = await glob("**/*.{pdf,txt}", { cwd: normalizedPath, absolute: true });
      res.json({ files: files.map(f => ({ path: f, name: path.basename(f) })) });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to list files", details: error.message });
    }
  });

  app.post("/api/index/file", async (req, res) => {
    if (!db) return res.status(500).json({ error: "Base de données non initialisée." });
    const { filePath, llamaConfig } = req.body;
    
    if (llamaConfig) {
      await ensureLlamaServerRunning(llamaConfig);
    }
    
    try {
      const fileBuffer = fs.readFileSync(filePath);
      let content = "";
      const ext = path.extname(filePath).toLowerCase();
      
      if (ext === ".pdf") {
        try {
          const parser = new PDFParse({ data: fileBuffer });
          const data = await parser.getText();
          content = data.text;
        } catch (pdfErr: any) {
          console.error(`[Indexing] PDF Parse error for ${filePath}:`, pdfErr);
          throw new Error(`Failed to parse PDF: ${pdfErr.message}`);
        }
      } else if (ext === ".txt") {
        content = fileBuffer.toString("utf-8");
      }

      if (!content.trim()) {
        return res.json({ status: "skipped", count: 0, reason: "Empty content" });
      }

      // 1. Calculate file content hash
      const fileHash = crypto.createHash('md5').update(content).digest('hex');
      const tableNames = await db.tableNames();
      const tableExists = tableNames.includes("manuels");

      // Verify if document is already indexed and hasn't changed (skip indexing optimization)
      if (tableExists) {
        const table = await db.openTable("manuels");
        const existing = await table.query()
          .where(`source = '${path.basename(filePath)}' AND hash = '${fileHash}'`)
          .limit(1)
          .toArray();
        
        if (existing.length > 0) {
          return res.json({ status: "skipped", count: 0, reason: "Already indexed with matching hash" });
        }
      }

      const indexedData = [];
      let idCounter = Date.now() % 100000;
      const settings = llamaConfig || {};

      const chunks = chunkText(content, 512, 64);
      // 2. Intra-document chunk deduplication (avoid redundant embeddings or identical text chunks)
      const uniqueChunkTexts: string[] = [];
      const seenChunkTexts = new Set<string>();
      for (const chunk of chunks) {
        const trimmed = chunk.trim();
        if (trimmed && !seenChunkTexts.has(trimmed)) {
          seenChunkTexts.add(trimmed);
          uniqueChunkTexts.push(trimmed);
        }
      }

      for (let i = 0; i < uniqueChunkTexts.length; i++) {
        const trimmedChunk = uniqueChunkTexts[i];
        const chunkHash = crypto.createHash('md5').update(trimmedChunk).digest('hex');

        let vector: number[] | null = null;

        // 3. Inter-document chunk reuse/deduplication (cache/retrieve embeddings of identical text chunks)
        if (tableExists) {
          try {
            const table = await db.openTable("manuels");
            const existingChunk = await table.query()
              .where(`chunk_hash = '${chunkHash}'`)
              .limit(1)
              .toArray();
            if (existingChunk.length > 0 && Array.isArray(existingChunk[0].vector)) {
              vector = existingChunk[0].vector;
              console.log(`[VectorDB] Reused existing vector for duplicate chunk text (chunk_hash: ${chunkHash})`);
            }
          } catch(err) {
            // Querying chunk_hash may fail if the column schema is new
          }
        }

        if (!vector) {
          vector = await getEmbeddings(trimmedChunk, settings);
        }

        if (vector && Array.isArray(vector) && vector.length > 0) {
          indexedData.push({
            id: `chunk_${idCounter}_${i}_${Date.now()}_${Number(random()).toString(36).substr(2, 9)}`,
            vector,
            content: trimmedChunk,
            source: path.basename(filePath),
            hash: fileHash,
            chunk_hash: chunkHash,
            type: 'chunk'
          });
        }
      }

      // 4. "Le hash doit se faire a la fin de l'indexation du fichier"
      // We only commit/update DB and replace old ones after successfully capturing everything at the end
      if (indexedData.length > 0) {
        let activeTable: lancedb.Table;
        const dim = await resolveEmbeddingDimension();
        if (!tableExists) {
          activeTable = await db.createTable("manuels", indexedData, { schema: getManuelsSchema(dim) });
        } else {
          activeTable = await db.openTable("manuels");
          // Safely delete older index mappings of this file filename at the end
          await activeTable.delete(`source = '${path.basename(filePath)}'`);
          try {
            await activeTable.add(indexedData);
          } catch(err: any) {
            if (err.message?.includes("dimension") || err.message?.includes("schema") || err.message?.includes("NaN") || err.message?.includes("Vector")) {
              console.warn("[Indexing] schema dimension mismatch or NaN corruption during manual index. Drop & override.", err.message);
              await db.dropTable("manuels");
              activeTable = await db.createTable("manuels", indexedData, { schema: getManuelsSchema(dim) });
            } else {
              throw err;
            }
          }
        }
        
        // 5. "Créé un index si besoin"
        await ensureVectorIndexOnTable(activeTable);
        table = activeTable; // keep global var in sync
      }

      res.json({ status: "success", count: indexedData.length });
    } catch (error: any) {
      console.error(`[Indexing] Error processing ${filePath}:`, error);
      res.status(500).json({ error: "File indexing failed", details: error.message });
    }
  });

  // Legacy Indexing Endpoint (kept for compatibility or bulk indexing)
  app.post("/api/index", async (req, res) => {
    if (!db) {
      return res.status(500).json({ error: "Base de données non initialisée." });
    }
    const { documentsPath, llamaConfig } = req.body;
    
    if (llamaConfig) {
      await ensureLlamaServerRunning(llamaConfig);
    }
    
    if (!documentsPath) {
      return res.status(400).json({ error: "Le chemin du dossier est requis." });
    }

    const normalizedPath = path.resolve(documentsPath);

    if (!fs.existsSync(normalizedPath)) {
      return res.status(400).json({ error: `Le dossier n'existe pas : ${normalizedPath}` });
    }

    try {
      const files = await glob("**/*.{pdf,txt}", { cwd: normalizedPath, absolute: true });
      if (files.length === 0) {
        return res.status(400).json({ error: "Aucun fichier .pdf ou .txt trouvé dans ce dossier." });
      }

      const indexedData = [];
      let idCounter = 100;
      const settings = llamaConfig || {};
      const tableNames = await db.tableNames();
      const tableExists = tableNames.includes("manuels");

      const filesToIndex = [];

      for (const file of files) {
        try {
          let content = "";
          const ext = path.extname(file).toLowerCase();
          
          if (ext === ".pdf") {
            const dataBuffer = fs.readFileSync(file);
            try {
              const parser = new PDFParse({ data: dataBuffer });
              const data = await parser.getText();
              content = data.text;
            } catch (pdfErr) {
              console.error(`[Indexing] PDF Parse error for ${file}:`, pdfErr);
            }
          } else if (ext === ".txt") {
            content = fs.readFileSync(file, "utf-8");
          }

          if (content.trim()) {
            const fileHash = crypto.createHash('md5').update(content).digest('hex');
            
            let skipFile = false;
            if (tableExists) {
              const activeTable = await db.openTable("manuels");
              const existing = await activeTable.query()
                .where(`source = '${path.basename(file)}' AND hash = '${fileHash}'`)
                .limit(1)
                .toArray();
              if (existing.length > 0) {
                skipFile = true;
              }
            }

            if (!skipFile) {
              filesToIndex.push({ file, content, fileHash });
            }
          }
        } catch (err) {
          console.error(`[Indexing] Error reading/checking file ${file}:`, err);
        }
      }

      for (const { file, content, fileHash } of filesToIndex) {
        const chunks = chunkText(content, 512, 64);
        
        // Intra-document chunk deduplication
        const uniqueChunkTexts: string[] = [];
        const seenChunkTexts = new Set<string>();
        for (const chunk of chunks) {
          const trimmed = chunk.trim();
          if (trimmed && !seenChunkTexts.has(trimmed)) {
            seenChunkTexts.add(trimmed);
            uniqueChunkTexts.push(trimmed);
          }
        }

        for (let i = 0; i < uniqueChunkTexts.length; i++) {
          const trimmedChunk = uniqueChunkTexts[i];
          const chunkHash = crypto.createHash('md5').update(trimmedChunk).digest('hex');
          
          let vector: number[] | null = null;
          
          if (tableExists) {
            try {
              const activeTable = await db.openTable("manuels");
              const existingChunk = await activeTable.query()
                .where(`chunk_hash = '${chunkHash}'`)
                .limit(1)
                .toArray();
              if (existingChunk.length > 0 && Array.isArray(existingChunk[0].vector)) {
                vector = existingChunk[0].vector;
                console.log(`[VectorDB] Reused vector for bulk duplication check (chunk_hash: ${chunkHash})`);
              }
            } catch (err) {}
          }
          
          if (!vector) {
            vector = await getEmbeddings(trimmedChunk, settings);
          }

          if (vector && Array.isArray(vector) && vector.length > 0) {
            indexedData.push({
              id: `chunk_bulk_${idCounter}_${i}_${Date.now()}_${Number(random()).toString(36).substr(2, 9)}`,
              vector,
              content: trimmedChunk,
              source: path.basename(file),
              hash: fileHash,
              chunk_hash: chunkHash,
              type: 'chunk'
            });
          }
        }
      }

      if (indexedData.length > 0) {
        let activeTable: lancedb.Table;
        const dim = await resolveEmbeddingDimension();
        if (!tableExists) {
          activeTable = await db.createTable("manuels", indexedData, { schema: getManuelsSchema(dim) });
        } else {
          activeTable = await db.openTable("manuels");
          // Deleting older records for these newly indexed files (late commit of hashes)
          for (const { file } of filesToIndex) {
            await activeTable.delete(`source = '${path.basename(file)}'`);
          }
          try {
            await activeTable.add(indexedData);
          } catch (tableErr: any) {
            if (tableErr.message?.includes("Invalid range") || tableErr.message?.includes("Generic memory error") || tableErr.message?.includes("dimension") || tableErr.message?.includes("schema") || tableErr.message?.includes("NaN") || tableErr.message?.includes("Vector")) {
              console.warn("[Indexing] Re-creating manuels table due to NaN, memory error, or schema mismatch:", tableErr.message);
              await db.dropTable("manuels");
              activeTable = await db.createTable("manuels", indexedData, { schema: getManuelsSchema(dim) });
            } else {
              throw tableErr;
            }
          }
        }
        
        // Generate or rebuild index if requested
        await ensureVectorIndexOnTable(activeTable);
        table = activeTable;
      }

      res.json({ status: "success", count: indexedData.length });
    } catch (error: any) {
      console.error("Indexing Error:", error);
      res.status(500).json({ error: "Indexing failed", details: error.message });
    }
  });

  // Document Vector Search
  app.post("/api/search", async (req, res) => {
    const { sujet, type, imagePath, question, settings } = req.body;
    
    if (settings) {
      await ensureLlamaServerRunning({
        model: settings.selectedModelPath,
        acceleration: settings.acceleration,
        useVulkan: settings.acceleration === "vulkan",
        useCuda: settings.acceleration === "cuda",
        useFlashAttention: settings.useFlashAttention,
        embeddingModelPath: settings.embeddingModelPath
      });
    }
    
    if (type === "image_analysis") {
      return res.json({ 
        results: [{ 
          content: `[Analysis] L'image ${imagePath} semble représenter un schéma d'apprentissage ou biologique pour la question: ${question}.`,
          source: "Analyse Visuelle" 
        }] 
      });
    }

    try {
      const results = await searchVectorDb(sujet, settings);
      const formattedResults = results.map(r => ({
        content: `[Document Source: ${r.source}] ${r.text || r.content}`,
        source: r.source
      }));

      res.json({ results: formattedResults });
    } catch (error) {
      console.error("Vector Search Error:", error);
      res.status(500).json({ error: "Search failed" });
    }
  });

  // JSON 404 for API routes
  app.use("/api/*", (req, res) => {
    res.status(404).json({ error: `Route ${req.originalUrl} not found` });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Professeur IA Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("[Server] Fatal error during startServer:", err);
});
