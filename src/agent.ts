import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  inference,
  metrics,
  voice,
} from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import EventEmitter from 'events';

dotenv.config({ path: '.env.local' });

const FILLERS = {
  en: ['uh', 'um', 'umm', 'hmm', 'mm', 'er', 'ah', 'haan'],
};

const URGENT = {
  en: ['stop', 'wait', 'hold', 'please stop'],
};

function normalizeWord(w) {
  return w.toLowerCase().trim();
}

function isAllFillers(transcript, lang = 'en') {
  const tokens = transcript
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const fillerSet = new Set(FILLERS[lang].map(normalizeWord));

  return (
    tokens.length > 0 &&
    tokens.every((t) => fillerSet.has(normalizeWord(t)))
  );
}

function isUrgentCommand(text, lang = 'en') {
  const list = URGENT[lang] || [];
  const t = text.toLowerCase();
  return list.some((k) => t.includes(k));
}

class VADInterceptor extends EventEmitter {
  constructor() {
    super();
    this.agentSpeaking = false;
  }

  setAgentSpeaking(flag) {
    this.agentSpeaking = flag;
  }

  handlePartialTranscript(text, lang = 'en') {
    
    console.log(`[VAD DEBUG] Partial transcript received: "${text}" (lang=${lang}) agentSpeaking=${this.agentSpeaking}`);

    if (!this.agentSpeaking) {
      
      console.log(`[VAD DEBUG] Agent is quiet → treating as real user speech`);
      this.emit('interrupt', { reason: 'agent-quiet', text });
      return;
    }
    if (isUrgentCommand(text, lang)) {
      
      console.log(`[VAD DEBUG] URGENT command detected → interrupting TTS (${text})`);
      this.emit('interrupt', { reason: 'urgent', text });
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
      stt: new inference.STT({
        model: 'assemblyai/universal-streaming',
        language: 'en',
        continuous: true,                   
        enablePartialCaptions: true,
        enableInterimResults: true,
      }),


      // A Large Language Model (LLM) is your agent's brain, processing user input and generating a response
      // See all providers at https://docs.livekit.io/agents/models/llm/
      llm: new inference.LLM({
        model: 'openai/gpt-4.1-mini',
      }),

      // Text-to-speech (TTS) is your agent's voice, turning the LLM's text into speech that the user can hear
      // See all available models as well as voice selections at https://docs.livekit.io/agents/models/tts/
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),

      // VAD and turn detection are used to determine when the user is speaking and when the agent should respond
      // See more at https://docs.livekit.io/agents/build/turns
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      vad: ctx.proc.userData.vad! as silero.VAD,
    });
    session.on(voice.AgentSessionEventTypes.Transcription, (ev) => {
      const text = ev?.transcript?.text ?? '';
      console.log("[DEBUG] Transcription event:", text);
      vadInterceptor.handlePartialTranscript(text, 'en');
    });

    session.on(voice.AgentSessionEventTypes.TTSStarted, () => {
      vadInterceptor.setAgentSpeaking(true);
      
      console.log(`[VAD DEBUG] TTS started → agentSpeaking=true`);
    });

    session.on(voice.AgentSessionEventTypes.TTSStopped, () => {
      vadInterceptor.setAgentSpeaking(false);
      
      console.log(`[VAD DEBUG] TTS stopped → agentSpeaking=false`);
    });

    session.on('user_input_transcribed', (ev) => {
      const text = ev?.transcript ?? '';     // note: new event uses "transcript" directly
      console.log(`[VAD DEBUG] (transcribed) "${text}"`);
      vadInterceptor.handlePartialTranscript(text, 'en');
    });

    : apply decisions
    vadInterceptor.on('interrupt', ({ reason, text }) => {
      console.log(`[VAD ACTION] INTERRUPT triggered → reason="${reason}" text="${text}"`);
      session.interrupt();
    });

    vadInterceptor.on('ignore', ({ reason, text }) => {
      console.log(`[VAD ACTION] IGNORE triggered → filler="${text}"`);
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
