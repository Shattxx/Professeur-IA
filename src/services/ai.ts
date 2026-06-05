import { AppSettings } from "../constants";
import { evaluate } from "mathjs";

export interface Message {
  role: "user" | "model" | "system";
  parts: { text: string }[];
  displayText?: string;
}

const MAX_TEMPERATURE = 0.4;

export function prepareMessages(systemPrompt: string, history: Message[], userMessage: string): any[] {
  const result: any[] = [];
  
  if (systemPrompt && systemPrompt.trim()) {
    result.push({ role: "system", content: systemPrompt });
  }

  // Pre-process items: map roles, handle text formatting
  const rawItems: { role: "user" | "assistant"; content: string }[] = [];

  for (const m of history) {
    const role = m.role === "model" ? "assistant" : "user";
    const content = m.parts?.[0]?.text || "";
    if (content && content.trim()) {
      rawItems.push({ role, content });
    }
  }

  if (userMessage && userMessage.trim()) {
    rawItems.push({ role: "user", content: userMessage });
  }

  // Merge consecutive messages with the same role and avoid immediate duplicate user text
  const alternating: { role: "user" | "assistant"; content: string }[] = [];
  for (const item of rawItems) {
    if (alternating.length === 0) {
      alternating.push(item);
    } else {
      const last = alternating[alternating.length - 1];
      if (last.role === item.role) {
        if (last.content.trim() === item.content.trim()) {
          // Skip identical contiguous message content (avoids history duplications)
        } else {
          last.content += "\n\n" + item.content;
        }
      } else {
        alternating.push(item);
      }
    }
  }

  // Ensure conversation starts with user if any alternating messages exist and the first is assistant
  if (alternating.length > 0 && alternating[0].role === "assistant") {
    alternating.unshift({ role: "user", content: "Bonjour" });
  }

  result.push(...alternating);
  return result;
}

export async function analyzeImageWithLlama(imageBase64: string, settings: AppSettings, prompt: string = "Analyse cette image pour un élève de collège. Explique ce que c'est et donne des informations éducatives pertinentes.") {
  const protocol = settings.llamaPort === '443' ? 'https' : 'http';
  const url = `${protocol}://${settings.llamaIp}${settings.llamaPort && settings.llamaPort !== '443' && settings.llamaPort !== '80' ? ':' + settings.llamaPort : ''}/v1/chat/completions`;
  
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { 
            role: "user", 
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
            ]
          }
        ],
        stream: false,
        temperature: MAX_TEMPERATURE,
        max_tokens: 2048,
        repeat_penalty: 1.0
      }),
    });

    if (!response.ok) throw new Error(`Llama.cpp vision connection failed: ${response.statusText}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "Désolé, je n'ai pas pu analyser cette image.";
  } catch (error) {
    console.error("Llama Image Analysis Error:", error);
    throw error;
  }
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Effectue des calculs mathématiques complexes (calculatrice scientifique).',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'L\'expression mathématique à évaluer (ex: "sqrt(16) + 2^3", "sin(pi/2)", "15 * 12").',
          },
        },
        required: ['expression'],
      },
    },
  },
];

export async function chatWithAI(history: Message[], userMessage: string, settings: AppSettings, onChunk?: (chunk: string) => void, signal?: AbortSignal, options?: { temperature?: number; disableTools?: boolean; max_tokens?: number }) {
  if (onChunk) {
    return chatWithLlamaStream(history, userMessage, settings, onChunk, signal, options);
  }
  return chatWithLlama(history, userMessage, settings, undefined, signal, options);
}

async function chatWithLlamaStream(history: Message[], userMessage: string, settings: AppSettings, onChunk: (chunk: string) => void, signal?: AbortSignal, extraOptions?: { temperature?: number; disableTools?: boolean; max_tokens?: number }) {
  const protocol = settings.llamaPort === '443' ? 'https' : 'http';
  const url = `${protocol}://${settings.llamaIp}${settings.llamaPort && settings.llamaPort !== '443' && settings.llamaPort !== '80' ? ':' + settings.llamaPort : ''}/v1/chat/completions`;
  
  let systemPrompt = settings.systemPrompt;
  if (settings.isThinkingEnabled) {
    systemPrompt += "\n\nMODE RÉFLEXION ACTIVÉ : Avant de donner ta réponse finale, détaille ton raisonnement étape par étape. Si le modèle le permet, utilise des balises <think> pour ton raisonnement.";
  }

  let messages = prepareMessages(systemPrompt, history, userMessage);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        messages,
        stream: true,
        ...(extraOptions?.disableTools ? {} : { tools: tools }),
        temperature: Math.min(extraOptions?.temperature ?? MAX_TEMPERATURE, MAX_TEMPERATURE),
        max_tokens: extraOptions?.max_tokens ?? 16384,
        repeat_penalty: 1.0
      }),
    });

    if (response.status === 400) {
      console.warn("Llama.cpp returned 400 with tools, retrying without tools...");
      const retryResponse = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages,
          stream: true,
          temperature: Math.min(extraOptions?.temperature ?? MAX_TEMPERATURE, MAX_TEMPERATURE),
          max_tokens: extraOptions?.max_tokens ?? 16384,
          repeat_penalty: 1.0
        }),
      });
      if (!retryResponse.ok) {
        const errorText = await retryResponse.text();
        throw new Error(`Llama connection failed (retry): ${retryResponse.status} ${retryResponse.statusText} - ${errorText}`);
      }
      const result = await processStream(retryResponse, onChunk, history, userMessage, settings);
      return { ...result, toolsSupported: false };
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Llama connection failed: ${response.status} ${response.statusText} - ${errorText}`);
    }
    const result = await processStream(response, onChunk, history, userMessage, settings);
    return { ...result, toolsSupported: true };
  } catch (error) {
    console.error("Llama Streaming Error:", error);
    throw error;
  }
}

async function processStream(response: Response, onChunk: (chunk: string) => void, history: Message[], userMessage: string, settings: AppSettings) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Failed to get reader from response body");

  let fullText = "";
  let toolCalls: any[] = [];
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || "";
    
    for (const line of lines) {
      const cleanLine = line.trim();
      if (!cleanLine || !cleanLine.startsWith('data: ')) continue;
      
      const dataStr = cleanLine.slice(6).trim();
      if (dataStr === '[DONE]') break;
      
      try {
        const json = JSON.parse(dataStr);
        
        // Handle OpenAI format tool calls
        const delta = json.choices?.[0]?.delta;
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index ?? toolCalls.length;
            if (!toolCalls[index]) {
              toolCalls[index] = { ...tc };
            } else {
              if (tc.function?.arguments) {
                if (!toolCalls[index].function) toolCalls[index].function = { arguments: "" };
                toolCalls[index].function.arguments = (toolCalls[index].function.arguments || "") + tc.function.arguments;
              }
              if (tc.function?.name) {
                if (!toolCalls[index].function) toolCalls[index].function = { name: "" };
                toolCalls[index].function.name = tc.function.name;
              }
            }
          }
        }

        if (delta?.content) {
          const content = delta.content;
          fullText += content;
          onChunk(content);
        }
      } catch (e) {
        // Line might be incomplete JSON, skip
      }
    }
  }

  // Handle any remaining lines in buffer
  if (buffer.trim().startsWith('data: ')) {
    const dataStr = buffer.trim().slice(6).trim();
    if (dataStr !== '[DONE]') {
      try {
        const json = JSON.parse(dataStr);
        const content = json.choices?.[0]?.delta?.content;
        if (content) {
          fullText += content;
          onChunk(content);
        }
      } catch(e) {}
    }
  }

  // If we have tool calls, we need to handle them (non-streaming for simplicity)
  if (toolCalls.length > 0) {
    const result = await chatWithLlama(history, userMessage, settings, toolCalls);
    return { ...result, text: fullText + (result.text || ''), toolsSupported: true };
  }

  return { text: fullText, functionCalls: null };
}

export async function chatWithLlama(history: Message[], userMessage: string, settings: AppSettings, initialToolCalls?: any[], signal?: AbortSignal, extraOptions?: { temperature?: number; disableTools?: boolean; max_tokens?: number }) {
  const protocol = settings.llamaPort === '443' ? 'https' : 'http';
  const url = `${protocol}://${settings.llamaIp}${settings.llamaPort && settings.llamaPort !== '443' && settings.llamaPort !== '80' ? ':' + settings.llamaPort : ''}/v1/chat/completions`;
  
  let systemPrompt = settings.systemPrompt;
  if (settings.isThinkingEnabled) {
    systemPrompt += "\n\nMODE RÉFLEXION ACTIVÉ : Avant de donner ta réponse finale, détaille ton raisonnement étape par étape. Si le modèle le permet, utilise des balises <think> pour ton raisonnement.";
  }

  let messages = prepareMessages(systemPrompt, history, userMessage);

  let toolsSupported = !extraOptions?.disableTools;

  try {
    let data;
    
    if (initialToolCalls && initialToolCalls.length > 0) {
      data = { choices: [{ message: { tool_calls: initialToolCalls, role: "assistant" } }] };
    } else {
      let response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          messages,
          stream: false,
          ...(extraOptions?.disableTools ? {} : { tools: tools }),
          temperature: Math.min(extraOptions?.temperature ?? MAX_TEMPERATURE, MAX_TEMPERATURE),
          max_tokens: extraOptions?.max_tokens ?? 16384,
          repeat_penalty: 1.0
        }),
      });

      if (response.status === 400) {
        console.warn("Llama returned 400 with tools, retrying without tools...");
        toolsSupported = false;
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages,
            stream: false,
            temperature: Math.min(extraOptions?.temperature ?? MAX_TEMPERATURE, MAX_TEMPERATURE),
            max_tokens: extraOptions?.max_tokens ?? 16384,
            repeat_penalty: 1.0
          }),
        });
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Llama connection failed: ${response.status} ${response.statusText} - ${errorText}`);
      }
      data = await response.json();
    }
    
    const choiceMessage = data.choices?.[0]?.message || {};
    let preamble = choiceMessage.content || "";
    
    // Handle tool calls
    if (choiceMessage.tool_calls && choiceMessage.tool_calls.length > 0) {
      const toolCalls = choiceMessage.tool_calls;
      messages.push(choiceMessage); // Add assistant message with tool calls

      for (const toolCall of toolCalls) {
        if (!toolCall || !toolCall.function) continue;
        if (toolCall.function.name === 'calculate') {
          let args;
          try {
            args = typeof toolCall.function.arguments === 'string' 
              ? JSON.parse(toolCall.function.arguments) 
              : toolCall.function.arguments;
          } catch (e) {
            console.error("[AI Tool] Failed to parse tool arguments:", toolCall.function.arguments);
            continue;
          }
          const expression = args.expression;
          console.log(`[AI Tool] Calling calculate with expression: ${expression}`);
          let result;
          try {
            result = evaluate(expression).toString();
            console.log(`[AI Tool] Calculation result: ${result}`);
          } catch (e: any) {
            console.error(`[AI Tool] Calculation error: ${e.message}`);
            result = `Erreur de calcul : ${e.message}`;
          }
          
          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: toolCall.id,
          });
        }
      }

      // Second call to server with tool results
      const secondResponse = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          messages,
          stream: false,
          tools: tools,
          temperature: Math.min(extraOptions?.temperature ?? MAX_TEMPERATURE, MAX_TEMPERATURE),
          max_tokens: 2048,
          repeat_penalty: 1.0
        }),
      });

      if (!secondResponse.ok) throw new Error("Llama connection failed after tool call");
      data = await secondResponse.json();
      
      return {
        text: preamble + (data.choices?.[0]?.message?.content || ""),
        functionCalls: null,
        toolsSupported
      };
    }
    
    return {
      text: preamble,
      functionCalls: null,
      toolsSupported
    };
  } catch (error) {
    console.error("Llama Error:", error);
    throw error;
  }
}
