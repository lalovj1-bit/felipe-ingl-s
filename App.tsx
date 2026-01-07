
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { GoogleGenAI, Modality } from "@google/genai";
import { QUESTIONS } from './constants';
import { GameState } from './types';

// --- UTILIDADES DE AUDIO PROFESIONALES ---
function decodeBase64(base64: string) {
  try {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  } catch (e) {
    console.error("❌ Error decodificando Base64:", e);
    return new Uint8Array();
  }
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer, data.byteOffset, data.length / 2);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

const MISSION_THEMES = ["Greetings", "Food & Drinks", "Routines", "Hobbies", "Body & Health"];
const MISSION_ICONS = ["👋", "🍕", "⏰", "⚽", "💪"];

const App: React.FC = () => {
  const [view, setView] = useState<'play' | 'create' | 'story'>('play');
  const [state, setState] = useState<GameState>({
    gameStarted: false,
    activeMission: 1,
    currentQuestionIndex: 0,
    userAnswer: '',
    attempts: 0,
    score: 0,
    feedbackType: 'none',
    feedbackMessage: '',
    isGameOver: false,
    showExplanation: false,
  });

  const [creationPrompt, setCreationPrompt] = useState('');
  const [createdImageUrl, setCreatedImageUrl] = useState<string | null>(null);
  const [isCreatingImage, setIsCreatingImage] = useState(false);
  const [storyWords, setStoryWords] = useState(['', '', '']);
  const [generatedStory, setGeneratedStory] = useState<{en: string, es: string} | null>(null);
  const [isGeneratingStory, setIsGeneratingStory] = useState(false);

  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);

  // --- COMPROBACIÓN DE SEGURIDAD DE LA LLAVE ---
  const checkApiKey = () => {
    try {
      const key = process.env.API_KEY;
      if (!key || key === "undefined" || key === "" || key.length < 10) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  useEffect(() => {
    if (!checkApiKey()) {
      setApiError("Falta la API_KEY en Netlify");
    } else {
      setApiError(null);
    }
  }, []);

  const missionQuestions = useMemo(() => 
    QUESTIONS.filter(q => q.mission === state.activeMission),
    [state.activeMission]
  );

  const currentQuestion = missionQuestions[state.currentQuestionIndex];

  // --- GESTIÓN DE AUDIO ROBUSTA ---
  const initAudio = async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }
    return audioContextRef.current;
  };

  const stopCurrentAudio = () => {
    if (currentSourceRef.current) {
      try { currentSourceRef.current.stop(); } catch(e) {}
      currentSourceRef.current = null;
    }
  };

  const playTTS = async (text: string, isEnglish: boolean = true) => {
    stopCurrentAudio();
    const ctx = await initAudio();
    setIsLoadingAudio(true);
    
    try {
      const apiKey = process.env.API_KEY;
      if (!apiKey || apiKey === "undefined") throw new Error("NO_KEY");

      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: `${isEnglish ? 'Repeat clearly:' : ''} ${text}` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: isEnglish ? 'Charon' : 'Kore' } },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const audioBuffer = await decodeAudioData(decodeBase64(base64Audio), ctx, 24000, 1);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        source.onended = () => setIsLoadingAudio(false);
        currentSourceRef.current = source;
        source.start(0);
        setApiError(null);
      }
    } catch (error: any) {
      console.error("Audio Error:", error);
      setIsLoadingAudio(false);
      setApiError("Voz no disponible. Revisa tu conexión o API KEY.");
    }
  };

  const startGame = async () => {
    await initAudio();
    if (!checkApiKey()) {
      setApiError("¡ALTO! No detecto la API_KEY. Ve a Netlify -> Site Settings -> Environment Variables.");
      return;
    }
    setState(prev => ({ ...prev, gameStarted: true }));
  };

  const handleOptionClick = (option: string) => {
    if (state.showExplanation) return;
    
    setState(prev => ({ ...prev, userAnswer: option }));
    const isCorrect = option.toLowerCase() === currentQuestion.correctAnswer.toLowerCase();

    if (isCorrect) {
      setState(prev => ({ 
        ...prev, 
        score: prev.score + 1, 
        feedbackType: 'success', 
        feedbackMessage: '¡Increíble! ¡Correcto! 🌟', 
        showExplanation: true 
      }));
      playTTS(`Correct! ${currentQuestion.translation}`, true);
    } else {
      if (state.attempts === 0) {
        setState(prev => ({ 
          ...prev, 
          attempts: 1, 
          feedbackType: 'hint', 
          feedbackMessage: `💡 Pista: ${currentQuestion.hint}` 
        }));
        playTTS("Try again!", true);
      } else {
        setState(prev => ({ 
          ...prev, 
          feedbackType: 'error', 
          feedbackMessage: `¡Oh no! Era: ${currentQuestion.correctAnswer}`, 
          showExplanation: true 
        }));
      }
    }
  };

  useEffect(() => {
    if (state.gameStarted && !state.showExplanation && !state.isGameOver && currentQuestion && view === 'play') {
      const timer = setTimeout(() => playTTS(currentQuestion.text, true), 600);
      return () => clearTimeout(timer);
    }
  }, [state.currentQuestionIndex, state.activeMission, state.gameStarted, view]);

  // --- UI RENDER ---
  if (!state.gameStarted) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="bg-white mario-card p-8 max-w-md w-full text-center shadow-2xl border-[6px] border-black">
          <div className="text-8xl mb-4 animate-bounce">🦖</div>
          <h1 className="text-4xl font-black text-red-600 mb-2">SUPER FELIPE</h1>
          <p className="text-blue-500 font-bold mb-6 uppercase tracking-wider">A1 English Explorer</p>
          
          {apiError ? (
            <div className="mb-6 bg-red-50 border-2 border-red-500 p-4 rounded-2xl text-red-600 text-sm">
              <p className="font-black mb-2">⚠️ ERROR DE CONEXIÓN</p>
              <p className="font-bold">No encuentro la API_KEY en Netlify.</p>
              <ol className="text-left mt-2 text-[11px] list-decimal pl-4 font-bold opacity-80">
                <li>Ve al panel de tu sitio en Netlify.</li>
                <li>Entra en <b>Site configuration</b> &rarr; <b>Environment variables</b>.</li>
                <li>Añade una variable llamada <b>API_KEY</b> con tu valor.</li>
                <li>Haz un <b>Trigger Deploy</b> (Clear cache and deploy).</li>
              </ol>
              <button onClick={() => window.location.reload()} className="mt-4 bg-red-600 text-white px-4 py-2 rounded-xl font-black text-xs uppercase">Reintentar Ahora</button>
            </div>
          ) : (
            <div className="mb-6 bg-green-50 border-2 border-green-500 p-4 rounded-2xl text-green-700 font-bold text-xs">
              ✅ Sistema de voz listo para la aventura.
            </div>
          )}

          <button 
            onClick={startGame}
            className="w-full bg-yellow-400 hover:bg-yellow-500 text-black font-black py-5 rounded-2xl mario-btn text-xl uppercase shadow-lg active:scale-95 transition-all"
          >
            ¡START GAME! &rarr;
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center p-4 pb-32">
      <header className="mb-4 text-center">
        <h1 className="text-3xl text-white font-black drop-shadow-md">SUPER FELIPE</h1>
        <div className="flex gap-2 justify-center mt-2">
            <span className="bg-white/20 text-white px-3 py-1 rounded-full text-[10px] font-black uppercase">
               {MISSION_THEMES[state.activeMission - 1]}
            </span>
            {apiError && <span className="bg-red-500 text-white px-2 py-1 rounded-lg text-[8px] font-black animate-pulse">VOZ OFF</span>}
        </div>
      </header>

      {view === 'play' && (
        <div className="w-full max-w-xl">
          <nav className="flex flex-wrap justify-center gap-1.5 mb-6">
            {MISSION_THEMES.map((name, idx) => (
              <button
                key={idx + 1}
                onClick={() => setState(s => ({...s, activeMission: idx + 1, currentQuestionIndex: 0, showExplanation: false, feedbackType: 'none', userAnswer: ''}))}
                className={`px-3 py-2 rounded-xl font-black text-[9px] uppercase transition-all mario-btn ${
                  state.activeMission === idx + 1 ? 'bg-yellow-400 text-black border-2 border-black' : 'bg-white/80 text-blue-600'
                }`}
              >
                {MISSION_ICONS[idx]} {name}
              </button>
            ))}
          </nav>
          
          <main className="bg-white mario-card p-6 md:p-8 relative border-[5px] border-black">
            {state.isGameOver ? (
              <div className="text-center py-6">
                <div className="text-6xl mb-4">⭐</div>
                <h2 className="text-3xl font-black text-green-600 mb-6 uppercase">Misión Cumplida</h2>
                <button onClick={() => setState(s => ({...s, isGameOver: false, currentQuestionIndex: 0, score: 0}))} className="w-full bg-red-600 text-white font-black py-4 rounded-xl mario-btn shadow-lg">VOLVER A JUGAR</button>
              </div>
            ) : (
              <>
                <div className="flex justify-between items-center mb-6">
                  <div className="bg-blue-600 text-white px-3 py-1 rounded-full font-black text-[10px]">STAGE {state.currentQuestionIndex + 1}</div>
                  <div className="font-black text-yellow-500 text-lg">⭐ {state.score}</div>
                </div>

                <div className="flex gap-4 items-center mb-6">
                  <button 
                    onClick={() => playTTS(currentQuestion.text)} 
                    disabled={isLoadingAudio}
                    className={`w-16 h-16 flex items-center justify-center rounded-2xl shadow-md active:scale-90 transition-transform ${isLoadingAudio ? 'bg-slate-200 animate-pulse text-slate-400' : 'bg-red-600 text-white border-b-4 border-red-800'}`}
                  >
                    {isLoadingAudio ? '...' : <span className="text-2xl">🔊</span>}
                  </button>
                  <h2 className="text-xl md:text-2xl font-black text-slate-800 leading-tight">
                    {currentQuestion.text.split('________').map((part, i, arr) => (
                      <React.Fragment key={i}>{part}{i < arr.length - 1 && <span className="text-red-600 border-b-4 border-red-200 mx-1">{state.userAnswer || "____"}</span>}</React.Fragment>
                    ))}
                  </h2>
                </div>

                {/* OPCIONES DE RESPUESTA (GRID DE 5) */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
                  {currentQuestion.options.map((option, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleOptionClick(option)}
                      disabled={state.showExplanation}
                      className={`p-4 text-lg font-black rounded-2xl uppercase transition-all mario-btn border-2 border-black ${
                        state.userAnswer === option 
                          ? 'bg-blue-500 text-white' 
                          : 'bg-slate-50 hover:bg-yellow-200 text-slate-800'
                      } ${state.showExplanation ? 'opacity-50 grayscale' : ''}`}
                    >
                      {option}
                    </button>
                  ))}
                </div>

                {state.feedbackType !== 'none' && (
                  <div className={`mt-6 p-5 rounded-2xl border-[3px] border-black ${state.feedbackType === 'success' ? 'bg-green-50' : 'bg-red-50'}`}>
                    <p className="font-black text-lg mb-2">{state.feedbackMessage}</p>
                    {state.showExplanation && (
                      <div className="space-y-3">
                        <p className="text-xl font-black text-blue-800 underline decoration-yellow-400">{currentQuestion.translation}</p>
                        <p className="text-xs text-slate-500 font-bold">{currentQuestion.explanation}</p>
                        <button onClick={() => {
                          if (state.currentQuestionIndex + 1 >= missionQuestions.length) setState(s => ({...s, isGameOver: true}));
                          else setState(s => ({...s, currentQuestionIndex: s.currentQuestionIndex + 1, userAnswer: '', showExplanation: false, feedbackType: 'none', attempts: 0}));
                        }} className="w-full py-4 bg-green-500 text-white font-black rounded-xl mario-btn uppercase">Siguiente Pregunta &rarr;</button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </main>
        </div>
      )}

      {/* --- VISTA LAB --- */}
      {view === 'create' && (
        <div className="w-full max-w-xl bg-white mario-card p-6 border-[5px] border-black">
          <h2 className="text-2xl font-black text-center mb-2 uppercase">Hero Lab 🧪</h2>
          <p className="text-center text-slate-500 font-bold text-xs mb-4">Describe a tu héroe en inglés para crearlo</p>
          <textarea
            value={creationPrompt}
            onChange={(e) => setCreationPrompt(e.target.value)}
            placeholder="Ex: A powerful robot with green eyes..."
            className="w-full h-24 p-4 border-4 border-slate-100 rounded-2xl mb-4 font-bold outline-none focus:border-blue-400"
          />
          <button onClick={() => {
             const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
             setIsCreatingImage(true);
             ai.models.generateContent({
               model: 'gemini-2.5-flash-image',
               contents: { parts: [{ text: `Superhero cartoon style: ${creationPrompt}` }] },
             }).then(res => {
               const img = res.candidates?.[0]?.content?.parts.find(p => p.inlineData);
               if (img?.inlineData) setCreatedImageUrl(`data:image/png;base64,${img.inlineData.data}`);
               setIsCreatingImage(false);
             }).catch(() => setIsCreatingImage(false));
          }} disabled={isCreatingImage} className="w-full bg-yellow-400 py-4 rounded-xl font-black mario-btn uppercase mb-4">
            {isCreatingImage ? 'Creando Magia...' : 'Generar Héroe ✨'}
          </button>
          <div className="aspect-square bg-slate-50 rounded-2xl border-4 border-dashed border-slate-200 flex items-center justify-center overflow-hidden">
            {createdImageUrl ? <img src={createdImageUrl} className="w-full h-full object-cover" /> : <span className="text-slate-300 font-black italic text-sm">Tu héroe aparecerá aquí</span>}
          </div>
        </div>
      )}

      {/* --- VISTA STORY --- */}
      {view === 'story' && (
        <div className="w-full max-w-xl bg-white mario-card p-6 border-[5px] border-black">
          <h2 className="text-2xl font-black text-center mb-4 uppercase">Cuentos Mágicos 📖</h2>
          <div className="flex gap-2 mb-4">
            {storyWords.map((w, i) => (
              <input key={i} value={w} onChange={(e) => { const n = [...storyWords]; n[i] = e.target.value; setStoryWords(n); }} placeholder={`Palabra ${i+1}`} className="w-1/3 p-2 border-2 border-slate-200 rounded-xl text-center font-bold text-xs" />
            ))}
          </div>
          <button onClick={() => {
            setIsGeneratingStory(true);
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            ai.models.generateContent({
              model: 'gemini-3-flash-preview',
              contents: `Short kids story in English using: ${storyWords.join(', ')}. Format: STORY: [english] TRANSLATION: [spanish]`,
            }).then(res => {
              const text = res.text || "";
              const en = text.match(/STORY: ([\s\S]*?)TRANSLATION:/i)?.[1].trim();
              const es = text.match(/TRANSLATION: ([\s\S]*)/i)?.[1].trim();
              if (en && es) setGeneratedStory({ en, es });
              setIsGeneratingStory(false);
            }).catch(() => setIsGeneratingStory(false));
          }} disabled={isGeneratingStory} className="w-full bg-green-500 text-white py-4 rounded-xl font-black mario-btn uppercase mb-6">
            {isGeneratingStory ? 'Escribiendo...' : '¡Inventar Cuento! ⚡'}
          </button>
          {generatedStory && (
            <div className="bg-yellow-50 p-5 rounded-2xl border-2 border-yellow-200">
              <p className="text-lg font-bold mb-4 italic text-slate-800">"{generatedStory.en}"</p>
              <button onClick={() => playTTS(generatedStory.en)} className="bg-white p-2 rounded-full shadow-sm border border-yellow-300 mb-4 flex items-center gap-2 px-4 active:scale-95 transition-transform">
                 <span className="text-xl">🔊</span> <span className="text-[10px] font-black uppercase">Escuchar a Felipe</span>
              </button>
              <div className="border-t border-yellow-200 pt-4">
                 <p className="text-slate-600 text-[11px] font-bold">{generatedStory.es}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* BARRA DE NAVEGACIÓN */}
      <footer className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 border-[3px] border-slate-700 rounded-full p-2 flex gap-1 shadow-2xl z-50">
        <button onClick={() => setView('play')} className={`px-5 py-2 rounded-full transition-all flex flex-col items-center ${view === 'play' ? 'bg-red-600 text-white' : 'text-slate-500'}`}>
          <span className="text-lg">🎮</span><span className="text-[7px] font-black uppercase">Aventura</span>
        </button>
        <button onClick={() => setView('create')} className={`px-5 py-2 rounded-full transition-all flex flex-col items-center ${view === 'create' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <span className="text-lg">🧪</span><span className="text-[7px] font-black uppercase">Laboratorio</span>
        </button>
        <button onClick={() => setView('story')} className={`px-5 py-2 rounded-full transition-all flex flex-col items-center ${view === 'story' ? 'bg-green-600 text-white' : 'text-slate-500'}`}>
          <span className="text-lg">📖</span><span className="text-[7px] font-black uppercase">Cuentos</span>
        </button>
      </footer>
    </div>
  );
};

export default App;
