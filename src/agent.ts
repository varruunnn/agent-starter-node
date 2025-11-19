import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
  stt,
  tts,
  voice,
} from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import EventEmitter from 'events';
import express from 'express';

dotenv.config({ path: '.env.local' });

type LanguageCode = 'en' | 'hi' | 'mixed';

const FILLERS: Record<LanguageCode, string[]> = {
  en: ['uh', 'um', 'umm', 'hmm', 'mm', 'er', 'ah', 'like'],
  hi: ['haan', 'hmm', 'achha', 'arey', 'matlab'],
  mixed: ['um', 'haan', 'hmm', 'achha', 'uh'], 
};

const URGENT: Record<string, string[]> = {
  en: ['stop', 'wait', 'hold', 'pause', 'shut up'],
};

function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "").trim();
}

function detectLanguage(text: string): LanguageCode {
  if (/[अ-ह]/.test(text)) return 'hi';
  return 'en';
}

function isUrgentCommand(text: string, lang: string = 'en'): boolean {
  const list = URGENT[lang] || URGENT['en'];
  const t = text.toLowerCase();
  return list.some((k) => t.includes(k));
}

function isAllFillers(transcript: string, lang: LanguageCode = 'en'): boolean {
  const tokens = transcript
    .toLowerCase()
    .split(/\s+/)
    .map(normalizeWord)
    .filter(Boolean);

  if (tokens.length === 0) return false; 
  const fillerSet = new Set(FILLERS[lang].map(normalizeWord));
  const mixedSet = new Set(FILLERS['mixed'].map(normalizeWord));
  return tokens.every((t) => fillerSet.has(t) || mixedSet.has(t));
}

class VADInterceptor extends EventEmitter {
  private agentSpeaking: boolean;

  constructor() {
    super();
    this.agentSpeaking = false;
  }

  setAgentSpeaking(flag: boolean) {
    this.agentSpeaking = flag;
  }

  handlePartialTranscript(text: string, lang: LanguageCode = 'en') {
    console.log(`[VAD DEBUG] Partial transcript received: "${text}" (lang=${lang}) agentSpeaking=${this.agentSpeaking}`);

    if (isUrgentCommand(text, lang)) {
      console.log(`[VAD DEBUG] URGENT command detected → interrupting TTS (${text})`);
      this.emit('interrupt', { reason: 'urgent', text });
      return;
    }

    if (!this.agentSpeaking) {
      console.log(`[VAD DEBUG] Agent is quiet → treating as real user speech`);
      return;
    }

    if (isAllFillers(text, lang)) {
      console.log(`[VAD DEBUG] Filler detected → ignoring ("${text}")`);
      this.emit('ignore', { reason: 'filler', text });
      return;
    }

    console.log(`[VAD DEBUG] Real user speech detected → interrupting TTS ("${text}")`);
    this.emit('interrupt', { reason: 'speech', text });
  }
}
const vadInterceptor = new VADInterceptor();

const app = express();
app.use(express.json());

app.get('/fillers', (req, res) => {
  res.json({ fillers: FILLERS });
});

app.post('/fillers/:lang', (req, res) => {
  const { lang } = req.params;
  const { words } = req.body;

  if (!Array.isArray(words)) {
    return res.status(400).json({ error: "words must be an array" });
  }
  if (lang in FILLERS) {
    FILLERS[lang as LanguageCode] = words;
    console.log(`[DYNAMIC] Updated filler list for ${lang}:`, words);
    res.json({ updated: FILLERS });
  } else {
    res.status(400).json({ error: "Invalid language code" });
  }
});

app.listen(3030, () => {
  console.log("Dynamic Filler API running at http://localhost:3030");
});

class Assistant extends voice.Agent {
  constructor() {
    super({
      instructions: `You are a helpful voice AI assistant. The user is interacting with you via voice, even if you perceive the conversation as text.
      You eagerly assist users with their questions by providing information from your extensive knowledge.
      Your responses are concise, to the point, and without any complex formatting or punctuation including emojis, asterisks, or other symbols.
      You are curious, friendly, and have a sense of humor.`,

      // To add tools, specify `tools` in the constructor.
      // Here's an example that adds a simple weather tool.
      // You also have to add `import { llm } from '@livekit/agents' and `import { z } from 'zod'` to the top of this file
      // tools: {
      //   getWeather: llm.tool({
      //     description: `Use this tool to look up current weather information in the given location.
      //
      //     If the location is not supported by the weather service, the tool will indicate this. You must tell the user the location's weather is unavailable.`,
      //     parameters: z.object({
      //       location: z
      //         .string()
      //         .describe('The location to look up weather information for (e.g. city name)'),
      //     }),
      //     execute: async ({ location }) => {
      //       console.log(`Looking up weather for ${location}`);
      //
      //       return 'sunny with a temperature of 70 degrees.';
      //     },
      //   }),
      // },
    });
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    console.log("All events keys:", Object.values(voice.AgentSessionEventTypes));
    // Set up a voice AI pipeline using OpenAI, Cartesia, AssemblyAI, and the LiveKit turn detector
    const session = new voice.AgentSession({
      // Speech-to-text (STT) is your agent's ears, turning the user's speech into text that the LLM can understand
      // See all available models at https://docs.livekit.io/agents/models/stt/
      stt: new stt.STT({
        model: 'assemblyai/universal-streaming',
        language: 'en',
      }),

      // A Large Language Model (LLM) is your agent's brain, processing user input and generating a response
      // See all providers at https://docs.livekit.io/agents/models/llm/
      llm: new llm.LLM({
        model: 'openai/gpt-4o-mini',
      }),

      // Text-to-speech (TTS) is your agent's voice, turning the LLM's text into speech that the user can hear
      // See all available models as well as voice selections at https://docs.livekit.io/agents/models/tts/
      tts: new tts.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),

      // VAD and turn detection are used to determine when the user is speaking and when the agent should respond
      // See more at https://docs.livekit.io/agents/build/turns
      turnDetection: new livekit.turnDetector.MultilingualModel({
        speechThreshold: 0.6,
      }),
      vad: ctx.proc.userData.vad! as silero.VAD,
    });

    session.on(voice.AgentSessionEventTypes.Transcription, (ev: voice.TranscriptionEvent) => {
      const text = ev.transcript.text;
      console.log("[DEBUG] Transcription event:", text);
      const lang = detectLanguage(text);
      vadInterceptor.handlePartialTranscript(text, lang);
    });

    session.on(voice.AgentSessionEventTypes.TTSStarted, () => {
      vadInterceptor.setAgentSpeaking(true);
      console.log(`[VAD DEBUG] TTS started → agentSpeaking=true`);
    });

    session.on(voice.AgentSessionEventTypes.TTSStopped, () => {
      vadInterceptor.setAgentSpeaking(false);
      console.log(`[VAD DEBUG] TTS stopped → agentSpeaking=false`);
    });

    // : apply decisions
    vadInterceptor.on('interrupt', ({ reason, text }) => {
      console.log(`[VAD ACTION] INTERRUPT triggered → reason="${reason}" text="${text}"`);
      session.interrupt();
    });

    vadInterceptor.on('ignore', ({ reason, text }) => {
      console.log(`[VAD ACTION] IGNORE triggered → filler="${text}"`);
      // Do not interrupt
    });

    const usageCollector = new metrics.UsageCollector();
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
      usageCollector.collect(ev.metrics);
    });

    const logUsage = async () => {
      const summary = usageCollector.getSummary();
      console.log(`Usage: ${JSON.stringify(summary)}`);
    };

    ctx.addShutdownCallback(logUsage);

    // Start the session, which initializes the voice pipeline and warms up the models
    await session.start({
      agent: new Assistant(),
      room: ctx.room,
      inputOptions: {
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });

    await ctx.connect();
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));