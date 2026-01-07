
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

// Mezclador de arrays (Fisher-Yates)
const shuffleArray = <T,>(array: T[]): T[] => {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

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
      setApiError("No se encontró la API_KEY");
    } else {
      setApiError(null);
    }
  }, []);

  const missionQuestions = useMemo(() => 
    QUESTIONS.filter(q => q.mission === state.activeMission),
    [state.activeMission]
  );

  const currentQuestion = missionQuestions[state.currentQuestionIndex];

  // Memorizamos las opciones mezcladas para que no cambien de posición al escribir o interactuar
  const shuffledOptions = useMemo(() => {
    if (!currentQuestion) return [];
    return shuffleArray(currentQuestion.options);
  }, [currentQuestion?.id]);

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
      setApiError("Voz desactivada");
    }
  };

  const startGame = async () => {
    await initAudio();
    if (!checkApiKey()) {
      setApiError("¡Falta la llave secreta (API_KEY)!");
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
            <div className="mb-6 bg-red-50 border-4 border-red-500 p-6 rounded-3xl text-red-600 text-sm shadow-inner">
              <p className="font-black mb-4 text-lg">⚠️ ¡FALTA ENERGÍA!</p>
              <div className="text-left space-y-3 font-bold">
                <p>Para activar a Felipe en Netlify:</p>
                <p>1️⃣ Ve a <span className="text-blue-600">Site Settings</span></p>
                <p>2️⃣ Busca <span className="text-blue-600">Environment Variables</span></p>
                <p>3️⃣ Crea <span className="bg-black text-white px-2 py-0.5 rounded">API_KEY</span> con tu código</p>
                <p>4️⃣ Haz clic en <span className="text-red-600 italic underline">Trigger Deploy</span></p>
              </div>
              <button 
                onClick={() => window.location.reload()} 
                className="mt-6 w-full bg-red-600 text-white px-4 py-3 rounded-2xl font-black text-sm uppercase shadow-lg active:translate-y-1 transition-all"
              >
                🔄 Ya la puse, REINTENTAR
              </button>
            </div>
          ) : (
            <div className="mb-6 bg-green-50 border-4 border-green-500 p-4 rounded-3xl text-green-700 font-bold text-sm">
              ✨ ¡SISTEMA LISTO PARA EL DESPEGUE! ✨
            </div>
          )}

          <button 
            onClick={startGame}
            className="w-full bg-yellow-400 hover:bg-yellow-500 text-black font-black py-5 rounded-3xl mario-btn text-2xl uppercase shadow-lg active:scale-95 transition-all border-4 border-black"
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
            <span className="bg-white/30 text-white px-4 py-1 rounded-full text-[12px] font-black uppercase tracking-widest backdrop-blur-sm">
               {MISSION_THEMES[state.activeMission - 1]}
            </span>
            {apiError && <span className="bg-red-500 text-white px-2 py-1 rounded-lg text-[8px] font-black animate-pulse">VOZ OFF</span>}
        </div>
      </header>

      {view === 'play' && (
        <div className="w-full max-w-xl">
          <nav className="flex flex-wrap justify-center gap-2 mb-6">
            {MISSION_THEMES.map((name, idx) => (
              <button
                key={idx + 1}
                onClick={() => setState(s => ({...s, activeMission: idx + 1, currentQuestionIndex: 0, showExplanation: false, feedbackType: 'none', userAnswer: ''}))}
                className={`px-4 py-2 rounded-2xl font-black text-[10px] uppercase transition-all mario-btn border-2 border-black ${
                  state.activeMission === idx + 1 ? 'bg-yellow-400 text-black scale-110 shadow-lg' : 'bg-white/80 text-blue-600 opacity-70'
                }`}
              >
                {MISSION_ICONS[idx]} {name}
              </button>
            ))}
          </nav>
          
          <main className="bg-white mario-card p-6 md:p-10 relative border-[6px] border-black">
            {state.isGameOver ? (
              <div className="text-center py-10">
                <div className="text-8xl mb-6">🏆</div>
                <h2 className="text-4xl font-black text-green-600 mb-8 uppercase italic">¡CAMPEÓN!</h2>
                <button onClick={() => setState(s => ({...s, isGameOver: false, currentQuestionIndex: 0, score: 0}))} className="w-full bg-red-600 text-white font-black py-5 rounded-2xl mario-btn shadow-lg text-xl">OTRA PARTIDA</button>
              </div>
            ) : (
              <>
                <div className="flex justify-between items-center mb-8">
                  <div className="bg-blue-600 text-white px-4 py-1 rounded-full font-black text-[12px] border-2 border-black shadow-sm">RETO {state.currentQuestionIndex + 1}</div>
                  <div className="font-black text-yellow-500 text-2xl drop-shadow-[2px_2px_0px_rgba(0,0,0,1)]">⭐ {state.score}</div>
                </div>

                <div className="flex gap-6 items-center mb-10">
                  <button 
                    onClick={() => playTTS(currentQuestion.text)} 
                    disabled={isLoadingAudio}
                    className={`w-20 h-20 flex items-center justify-center rounded-3xl shadow-[6px_6px_0px_rgba(0,0,0,1)] active:scale-90 transition-transform border-4 border-black ${isLoadingAudio ? 'bg-slate-200 animate-pulse text-slate-400' : 'bg-red-600 text-white'}`}
                  >
                    {isLoadingAudio ? '...' : <span className="text-4xl">🔊</span>}
                  </button>
                  <h2 className="text-2xl md:text-3xl font-black text-slate-800 leading-tight">
                    {currentQuestion.text.split('________').map((part, i, arr) => (
                      <React.Fragment key={i}>{part}{i < arr.length - 1 && <span className="text-red-600 border-b-8 border-red-200 mx-2 inline-block min-w-[80px] text-center">{state.userAnswer || "____"}</span>}</React.Fragment>
                    ))}
                  </h2>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
                  {shuffledOptions.map((option, idx) => (
                    <button
                      key={`${currentQuestion.id}-${idx}`}
                      onClick={() => handleOptionClick(option)}
                      disabled={state.showExplanation}
                      className={`p-5 text-xl font-black rounded-3xl uppercase transition-all mario-btn border-4 border-black shadow-[4px_4px_0px_rgba(0,0,0,1)] ${
                        state.userAnswer === option 
                          ? 'bg-blue-500 text-white scale-105' 
                          : 'bg-white hover:bg-yellow-200 text-slate-800'
                      } ${state.showExplanation ? 'opacity-40 grayscale-50' : ''}`}
                    >
                      {option}
                    </button>
                  ))}
                </div>

                {state.feedbackType !== 'none' && (
                  <div className={`mt-8 p-6 rounded-3xl border-4 border-black shadow-xl animate-in slide-in-from-bottom-4 duration-300 ${state.feedbackType === 'success' ? 'bg-green-100' : 'bg-red-100'}`}>
                    <p className="font-black text-2xl mb-4 text-center">{state.feedbackMessage}</p>
                    {state.showExplanation && (
                      <div className="space-y-5">
                        <div className="bg-white/50 p-4 rounded-2xl border-2 border-black/10">
                           <p className="text-2xl font-black text-blue-900 mb-1">{currentQuestion.translation}</p>
                           <p className="text-sm text-slate-600 font-bold italic">{currentQuestion.explanation}</p>
                        </div>
                        <button onClick={() => {
                          if (state.currentQuestionIndex + 1 >= missionQuestions.length) setState(s => ({...s, isGameOver: true}));
                          else setState(s => ({...s, currentQuestionIndex: s.currentQuestionIndex + 1, userAnswer: '', showExplanation: false, feedbackType: 'none', attempts: 0}));
                        }} className="w-full py-5 bg-green-500 text-white font-black rounded-2xl mario-btn border-4 border-black uppercase text-xl shadow-lg">
                          ¡SIGUIENTE NIVEL! &rarr;
                        </button>
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
        <div className="w-full max-w-xl bg-white mario-card p-8 border-[6px] border-black">
          <h2 className="text-3xl font-black text-center mb-2 uppercase italic text-blue-600">HERO LAB 🧪</h2>
          <p className="text-center text-slate-500 font-bold text-sm mb-6">Dibuja tu héroe con palabras mágicas</p>
          <textarea
            value={creationPrompt}
            onChange={(e) => setCreationPrompt(e.target.value)}
            placeholder="Ex: A powerful robot with green eyes..."
            className="w-full h-32 p-5 border-4 border-slate-200 rounded-3xl mb-6 font-bold outline-none focus:border-blue-400 text-lg shadow-inner"
          />
          <button onClick={() => {
             const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
             setIsCreatingImage(true);
             ai.models.generateContent({
               model: 'gemini-2.5-flash-image',
               contents: { parts: [{ text: `Superhero cartoon style for kids: ${creationPrompt}` }] },
             }).then(res => {
               const img = res.candidates?.[0]?.content?.parts.find(p => p.inlineData);
               if (img?.inlineData) setCreatedImageUrl(`data:image/png;base64,${img.inlineData.data}`);
               setIsCreatingImage(false);
             }).catch(() => setIsCreatingImage(false));
          }} disabled={isCreatingImage} className="w-full bg-yellow-400 py-5 rounded-2xl font-black mario-btn border-4 border-black uppercase text-xl mb-6 shadow-lg">
            {isCreatingImage ? '💥 CREANDO...' : '¡GENERAR HÉROE! ✨'}
          </button>
          <div className="aspect-square bg-slate-100 rounded-3xl border-4 border-dashed border-slate-300 flex items-center justify-center overflow-hidden shadow-inner">
            {createdImageUrl ? <img src={createdImageUrl} className="w-full h-full object-cover" /> : <div className="text-slate-400 font-black italic text-center p-8">Tu creación aparecerá aquí</div>}
          </div>
        </div>
      )}

      {/* --- VISTA STORY --- */}
      {view === 'story' && (
        <div className="w-full max-w-xl bg-white mario-card p-8 border-[6px] border-black">
          <h2 className="text-3xl font-black text-center mb-6 uppercase italic text-green-600">CUENTOS MÁGICOS 📖</h2>
          <div className="grid grid-cols-3 gap-3 mb-6">
            {storyWords.map((w, i) => (
              <input key={i} value={w} onChange={(e) => { const n = [...storyWords]; n[i] = e.target.value; setStoryWords(n); }} placeholder={`Palabra ${i+1}`} className="p-3 border-4 border-slate-100 rounded-2xl text-center font-black text-sm outline-none focus:border-green-400" />
            ))}
          </div>
          <button onClick={() => {
            setIsGeneratingStory(true);
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            ai.models.generateContent({
              model: 'gemini-3-flash-preview',
              contents: `Short children's story (max 50 words) in English using: ${storyWords.join(', ')}. Format: STORY: [english] TRANSLATION: [spanish]`,
            }).then(res => {
              const text = res.text || "";
              const en = text.match(/STORY: ([\s\S]*?)TRANSLATION:/i)?.[1].trim();
              const es = text.match(/TRANSLATION: ([\s\S]*)/i)?.[1].trim();
              if (en && es) setGeneratedStory({ en, es });
              setIsGeneratingStory(false);
            }).catch(() => setIsGeneratingStory(false));
          }} disabled={isGeneratingStory} className="w-full bg-green-500 text-white py-5 rounded-2xl font-black mario-btn border-4 border-black uppercase text-xl mb-8 shadow-lg">
            {isGeneratingStory ? '✍️ ESCRIBIENDO...' : '¡INVENTAR CUENTO! ⚡'}
          </button>
          {generatedStory && (
            <div className="bg-yellow-50 p-6 rounded-3xl border-4 border-yellow-200 shadow-inner">
              <p className="text-xl font-bold mb-6 italic text-slate-800 leading-relaxed">"{generatedStory.en}"</p>
              <button onClick={() => playTTS(generatedStory.en)} className="bg-white p-4 rounded-2xl shadow-md border-4 border-yellow-400 mb-6 flex items-center justify-center gap-3 w-full active:scale-95 transition-transform">
                 <span className="text-3xl">🔊</span> <span className="text-sm font-black uppercase">¡QUE FELIPE LO LEA!</span>
              </button>
              <div className="border-t-4 border-yellow-200 pt-6">
                 <p className="text-slate-600 text-sm font-bold leading-relaxed">{generatedStory.es}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* BARRA DE NAVEGACIÓN ESTILO GAMEBOY */}
      <footer className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 border-[4px] border-slate-700 rounded-3xl p-3 flex gap-2 shadow-2xl z-50">
        <button onClick={() => setView('play')} className={`px-6 py-3 rounded-2xl transition-all flex flex-col items-center border-2 border-transparent ${view === 'play' ? 'bg-red-600 text-white border-white/50 scale-110 shadow-lg' : 'text-slate-500 opacity-60'}`}>
          <span className="text-2xl">🎮</span><span className="text-[9px] font-black uppercase mt-1">Jugar</span>
        </button>
        <button onClick={() => setView('create')} className={`px-6 py-3 rounded-2xl transition-all flex flex-col items-center border-2 border-transparent ${view === 'create' ? 'bg-blue-600 text-white border-white/50 scale-110 shadow-lg' : 'text-slate-500 opacity-60'}`}>
          <span className="text-2xl">🧪</span><span className="text-[9px] font-black uppercase mt-1">Lab</span>
        </button>
        <button onClick={() => setView('story')} className={`px-6 py-3 rounded-2xl transition-all flex flex-col items-center border-2 border-transparent ${view === 'story' ? 'bg-green-600 text-white border-white/50 scale-110 shadow-lg' : 'text-slate-500 opacity-60'}`}>
          <span className="text-2xl">📖</span><span className="text-[9px] font-black uppercase mt-1">Cuentos</span>
        </button>
      </footer>
    </div>
  );
};

export default App;
