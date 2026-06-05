import React from 'react';
import { motion } from 'framer-motion';
import { random } from 'mathjs';

interface AvatarProps {
  isSpeaking: boolean;
  scale?: number;
}

export const Avatar: React.FC<AvatarProps> = ({ isSpeaking, scale = 1 }) => {
  return (
    <div 
      className="relative flex flex-col items-center justify-center origin-center transition-transform duration-500"
      style={{ 
        transform: `scale(${scale})`,
        perspective: '1000px'
      }}
    >
      {/* Top Gear */}
      <motion.div 
        animate={{ rotate: 360 }}
        transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
        className="w-8 h-8 bg-slate-400 rounded-full border-2 border-slate-500 z-10 -mb-2 flex items-center justify-center shadow-lg"
        style={{ transform: 'translateZ(20px)' }}
      >
        <div className="w-1 h-4 bg-slate-500 absolute rotate-0" />
        <div className="w-1 h-4 bg-slate-500 absolute rotate-45" />
        <div className="w-1 h-4 bg-slate-500 absolute rotate-90" />
        <div className="w-1 h-4 bg-slate-500 absolute rotate-135" />
        <div className="w-4 h-4 bg-slate-300 rounded-full z-10" />
      </motion.div>

      {/* Robot Head Container */}
      <motion.div
        animate={{
          y: [0, -8, 0],
          rotateX: isSpeaking ? [0, 15, 0] : 0,
          rotateY: isSpeaking ? [-15, 15, -15] : 0,
        }}
        transition={{
          y: { duration: 4, repeat: Infinity, ease: "easeInOut" },
          rotateX: { duration: 0.8, repeat: isSpeaking ? Infinity : 0, ease: "easeInOut" },
          rotateY: { duration: 4, repeat: isSpeaking ? Infinity : 0, ease: "easeInOut" },
        }}
        className="relative w-44 h-44 rounded-[3.5rem] shadow-2xl border-4 border-slate-400 overflow-hidden flex flex-col items-center justify-center"
        style={{
          background: 'radial-gradient(circle at 30% 30%, #475569 0%, #1e293b 100%)',
          boxShadow: 'inset -12px -12px 20px rgba(0,0,0,0.6), 12px 12px 30px rgba(0,0,0,0.4)',
          transformStyle: 'preserve-3d',
        }}
      >
        {/* Colorful Panels */}
        <div className="absolute top-0 left-0 w-full h-1/2 bg-blue-500/20 rounded-t-3xl" />
        <div className="absolute bottom-0 left-0 w-full h-1/3 bg-orange-500/20 rounded-b-3xl" />
        <div className="absolute top-1/4 left-0 w-4 h-1/2 bg-pink-500/30 rounded-r-full" />
        <div className="absolute top-1/4 right-0 w-4 h-1/2 bg-pink-500/30 rounded-l-full" />

        {/* Antennas */}
        <div className="absolute -top-4 left-6 w-1.5 h-10 bg-slate-400 rounded-full origin-bottom rotate-[-15deg]">
          <motion.div 
            animate={{ scale: [1, 1.5, 1], opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 0.8, repeat: Infinity }}
            className="absolute -top-2 -left-1.5 w-4 h-4 bg-blue-400 rounded-full blur-[2px] shadow-[0_0_10px_#60a5fa]" 
          />
        </div>
        <div className="absolute -top-4 right-6 w-1.5 h-10 bg-slate-400 rounded-full origin-bottom rotate-[15deg]">
          <motion.div 
            animate={{ scale: [1, 1.5, 1], opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 1, repeat: Infinity }}
            className="absolute -top-2 -left-1.5 w-4 h-4 bg-blue-400 rounded-full blur-[2px] shadow-[0_0_10px_#60a5fa]" 
          />
        </div>

        {/* Eyes */}
        <div className="flex gap-4 mb-6 mt-2">
          {[0, 1].map((i) => (
            <div key={i} className="relative w-16 h-16 bg-black rounded-full border-4 border-slate-500 flex items-center justify-center overflow-hidden shadow-[inset_0_0_15px_rgba(0,0,0,0.8)]">
              {/* Concentric LED Rings */}
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 15, repeat: Infinity, ease: "linear" }}
                className="absolute inset-1 border-2 border-dashed border-blue-500/40 rounded-full"
              />
              <motion.div
                animate={{ rotate: -360 }}
                transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
                className="absolute inset-3 border-2 border-dotted border-blue-400/30 rounded-full"
              />
              {/* Pupil / Core */}
              <motion.div
                animate={{
                  scale: isSpeaking ? [1, 1.15, 1] : 1,
                  filter: isSpeaking ? ['brightness(1)', 'brightness(1.5)', 'brightness(1)'] : 'brightness(1)',
                }}
                transition={{ duration: 0.3, repeat: isSpeaking ? Infinity : 0 }}
                className="relative w-6 h-6 bg-blue-500 rounded-full shadow-[0_0_20px_#3b82f6]"
              >
                <div className="absolute top-1 left-1 w-2 h-2 bg-white rounded-full opacity-60" />
                <div className="absolute bottom-1 right-1 w-1 h-1 bg-white rounded-full opacity-40" />
              </motion.div>
            </div>
          ))}
        </div>

        {/* Mouth Screen (The Waveform) */}
        <div className="w-32 h-14 bg-slate-950 rounded-2xl border-2 border-slate-700 flex items-center justify-center overflow-hidden relative shadow-[inset_0_0_10px_rgba(0,0,0,1)]">
          <div className="flex items-center gap-1 h-full px-2">
            {[...Array(16)].map((_, i) => (
              <motion.div
                key={i}
                animate={{
                  height: isSpeaking ? [6, 36, 12, 30, 6] : 6,
                  opacity: isSpeaking ? [0.6, 1, 0.6] : 0.4,
                }}
                transition={{
                  duration: 0.3 + (Number(random()) * 0.2),
                  repeat: Infinity,
                  delay: i * 0.04,
                  ease: "easeInOut"
                }}
                className="w-1.5 bg-blue-400 rounded-full shadow-[0_0_8px_#60a5fa]"
              />
            ))}
          </div>
          {/* Scanline / Grid effect */}
          <div className="absolute inset-0 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_2px,3px_100%] pointer-events-none" />
        </div>

        {/* Bolts and Details */}
        <div className="absolute top-1/2 left-3 w-2 h-2 bg-slate-500 rounded-full shadow-inner" />
        <div className="absolute top-1/2 right-3 w-2 h-2 bg-slate-500 rounded-full shadow-inner" />
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-12 h-1 bg-slate-700 rounded-full opacity-50" />
      </motion.div>

      {/* Neck */}
      <div className="w-12 h-4 bg-slate-600 -mt-1 rounded-sm border-x-2 border-slate-700" />
      <div className="w-16 h-2 bg-slate-700 rounded-full" />

      {/* Floating Shadow */}
      <motion.div 
        animate={{ scale: [1, 1.1, 1], opacity: [0.1, 0.15, 0.1] }}
        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
        className="absolute -bottom-6 w-36 h-6 bg-black blur-xl rounded-full" 
      />
    </div>
  );
};
