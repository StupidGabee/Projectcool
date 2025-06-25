document.addEventListener('DOMContentLoaded', async () => {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const notesSharp = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    
    let scheduler = null;
    let activeSources = [];

    // Referências aos elementos DOM
    const musicSheetTextarea = document.getElementById('music-sheet');
    const playBtn = document.getElementById('play-btn');
    const stopBtn = document.getElementById('stop-btn');
    const downloadMp3Btn = document.getElementById('download-mp3-btn');
    const fullPianoKeysContainer = document.getElementById('full-piano-keys-container');
    const volumeSlider = document.getElementById('volume-slider');
    const volumeDisplay = document.getElementById('volume-display');
    const clearSheetBtn = document.getElementById('clear-sheet-btn');
    const tempoSlider = document.getElementById('tempo-slider');
    const tempoDisplay = document.getElementById('tempo-display');
    const mp3Status = document.getElementById('mp3-status');
    
    const DEFAULT_TREMOLO_SUB_NOTES = 3;

    // --- Funções Utilitárias ---
    function midiToNoteName(midiNum) {
        if (midiNum < 21 || midiNum > 108) return null; // Piano padrão de 88 teclas (A0-C8)
        const octave = Math.floor(midiNum / 12) - 1;
        const noteIndex = midiNum % 12;
        return notesSharp[noteIndex] + octave;
    }

    function noteMidiToFrequency(midi) {
        return 440 * Math.pow(2, (midi - 69) / 12);
    }

    // --- NOVO SINTETIZADOR DE PIANO ---
    function createPianoSound(midiNum, volumeLevel, durationMs, startTime, options = {}, audioCtx = audioContext) {
        if (!audioCtx) return;
        if (audioCtx.state === 'suspended') audioCtx.resume();

        const fundamentalFreq = noteMidiToFrequency(midiNum);
        if (fundamentalFreq <= 0) return;

        // Harmônicos para um som de piano mais rico
        const harmonics = [
            { ratio: 1, amp: 0.6, decay: 0.9 },   // Fundamental
            { ratio: 2, amp: 0.2, decay: 1.1 },   // 1st overtone
            { ratio: 3, amp: 0.1, decay: 1.5 },   // 2nd overtone
            { ratio: 4, amp: 0.08, decay: 1.8 },  // 3rd overtone
            { ratio: 5, amp: 0.04, decay: 2.2 },  // 4th overtone
            { ratio: 6, amp: 0.02, decay: 2.5 }   // 5th overtone
        ];
        
        let effectiveVolumeStart = volumeLevel;
        if (options.accent) {
            effectiveVolumeStart = Math.min(9, Math.ceil(volumeLevel * 1.3));
        }
        
        const maxGain = 0.6; // Reduzido para evitar clipping com múltiplos harmônicos
        const startGainValue = Math.max(0.001, (effectiveVolumeStart / 9) * maxGain);
        let endGainValue = startGainValue;
        
        // Aplicar Crescendo/Decrescendo
        if (options.crescendoValue !== undefined) {
            let targetVol = options.crescendoValue === 0 ? Math.min(9, effectiveVolumeStart + 3) : options.crescendoValue;
            endGainValue = (Math.max(1, Math.min(9, targetVol)) / 9) * maxGain;
        } else if (options.decrescendoValue !== undefined) {
            let targetVol = options.decrescendoValue === 0 ? Math.max(1, effectiveVolumeStart - 3) : options.decrescendoValue;
            endGainValue = (Math.max(1, Math.min(9, targetVol)) / 9) * maxGain;
        }
        endGainValue = Math.max(0.001, endGainValue);

        let effectiveDurationMs = durationMs;
        if (options.staccato) effectiveDurationMs = durationMs * 0.35;
        else if (options.legato) effectiveDurationMs = durationMs * 1.5;

        const effectiveDurationSec = Math.max(0.05, effectiveDurationMs / 1000);
        const finalEndTime = startTime + effectiveDurationSec;

        const mainGain = audioCtx.createGain();
        mainGain.connect(audioCtx.destination);
        mainGain.gain.setValueAtTime(0, startTime);
        mainGain.gain.linearRampToValueAtTime(startGainValue, startTime + 0.01);
        if(startGainValue !== endGainValue) {
            mainGain.gain.linearRampToValueAtTime(endGainValue, finalEndTime - 0.02);
        }
        mainGain.gain.linearRampToValueAtTime(0.0001, finalEndTime);

        // Inharmonicity: overtones em um piano são ligeiramente mais agudos
        const inharmonicity = 0.0006 * (midiNum / 88); 

        harmonics.forEach(h => {
            const osc = audioCtx.createOscillator();
            const oscGain = audioCtx.createGain();
            
            osc.type = 'sine';
            const detunedFreq = fundamentalFreq * h.ratio * (1 + inharmonicity * h.ratio * h.ratio);
            osc.frequency.value = detunedFreq;
            
            oscGain.connect(mainGain);
            
            // Envelope de decaimento individual para cada harmônico
            const decayDuration = effectiveDurationSec * h.decay;
            oscGain.gain.setValueAtTime(h.amp, startTime);
            oscGain.gain.exponentialRampToValueAtTime(0.001, startTime + decayDuration);

            osc.start(startTime);
            osc.stop(startTime + decayDuration + 0.1);

            if (audioCtx === audioContext) {
                 activeSources.push({ source: osc, gainNode: mainGain });
                 osc.onended = () => {
                    activeSources = activeSources.filter(s => s.source !== osc);
                 };
            }
        });
    }

    // --- Parser da Sequência (sem alterações, já é robusto) ---
    function parseSequence(sequenceText) {
        const parsedEvents = [];
        const timeEventsStrings = sequenceText.trim().split(/\s+/); 

        for (const timeEventStr of timeEventsStrings) {
            if (timeEventStr.trim() === "") continue; 
            
            const notesToPlayInThisEvent = [];
            const individualNoteStrings = timeEventStr.split('|');

            for (const noteStr of individualNoteStrings) {
                const trimmedNoteStr = noteStr.trim();
                if (trimmedNoteStr === "") continue;

                const matchBaseAndMods = trimmedNoteStr.match(/^([A-G]#?[0-8]-[1-9])(.*)$/i);
                if (!matchBaseAndMods) {
                    console.warn("Formato de nota inválido (ignorado):", trimmedNoteStr);
                    continue;
                }

                const noteBaseStr = matchBaseAndMods[1];
                let modifiersStr = matchBaseAndMods[2] || "";

                const noteParts = noteBaseStr.match(/^([A-G]#?)([0-8])-([1-9])$/i);
                if (!noteParts) {
                    console.warn("Formato de nota base inválido (ignorado):", noteBaseStr);
                    continue; 
                }
                
                const noteName = noteParts[1].toUpperCase();
                const octaveNum = parseInt(noteParts[2]);
                const volume = parseInt(noteParts[3]);
                const noteIndex = notesSharp.indexOf(noteName);

                if (noteIndex === -1) {
                    console.warn("Nome de nota inválido (ignorado):", noteName, "em", trimmedNoteStr);
                    continue; 
                }
                const midiNum = (octaveNum + 1) * 12 + noteIndex;
                
                let tremoloRepeats = 0;
                let crescendoValue = undefined; 
                let decrescendoValue = undefined;
                
                let modMatch = modifiersStr.match(/\*(\d+)/);
                if (modMatch) {
                    tremoloRepeats = parseInt(modMatch[1]);
                    if (tremoloRepeats < 1) tremoloRepeats = 1; 
                    modifiersStr = modifiersStr.replace(modMatch[0], '');
                } else if (modifiersStr.includes('*')) { 
                    tremoloRepeats = DEFAULT_TREMOLO_SUB_NOTES;
                    modifiersStr = modifiersStr.replace('*', '');
                }
                
                modMatch = modifiersStr.match(/\+\((\d+)\)/); 
                if (modMatch) {
                    crescendoValue = parseInt(modMatch[1]);
                    if (crescendoValue < 1 || crescendoValue > 9) crescendoValue = 0;
                    modifiersStr = modifiersStr.replace(modMatch[0], '');
                } else if (modifiersStr.includes('+')) { 
                    crescendoValue = 0; 
                    modifiersStr = modifiersStr.replace('+', '');
                }

                if (crescendoValue === undefined) {
                    modMatch = modifiersStr.match(/-\((\d+)\)/);
                    if (modMatch) {
                        decrescendoValue = parseInt(modMatch[1]);
                        if (decrescendoValue < 1 || decrescendoValue > 9) decrescendoValue = 0;
                        modifiersStr = modifiersStr.replace(modMatch[0], '');
                    } else if (modifiersStr.includes('-')) { 
                        decrescendoValue = 0; 
                        modifiersStr = modifiersStr.replace('-', '');
                    }
                }
                
                notesToPlayInThisEvent.push({
                    midi: midiNum, volume: volume,
                    tremoloRepeats: tremoloRepeats, 
                    staccato: modifiersStr.includes('.'),
                    accent: modifiersStr.includes('^'),
                    legato: modifiersStr.includes('_'),
                    crescendoValue: crescendoValue, 
                    decrescendoValue: decrescendoValue
                });
            }
            if (notesToPlayInThisEvent.length > 0) {
                parsedEvents.push({ notesToPlay: notesToPlayInThisEvent });
            }
        }
        return parsedEvents;
    }

    // --- Geração dos Botões do Painel ---
    function generateFullPianoButtons() {
        fullPianoKeysContainer.innerHTML = '';
        for (let midiNum = 21; midiNum <= 108; midiNum++) {
            const fullNoteName = midiToNoteName(midiNum);
            if (!fullNoteName) continue; 
            const noteButton = document.createElement('button');
            noteButton.classList.add('note-btn');
            noteButton.textContent = fullNoteName;
            noteButton.dataset.midi = midiNum;
            const notePart = fullNoteName.slice(0, -1);
            if (notePart.includes('#')) noteButton.classList.add('black-key-style');
            if (notePart === 'C') noteButton.classList.add('c-key');
            noteButton.title = `Tocar ${fullNoteName}`;
            
            noteButton.addEventListener('mousedown', (e) => {
                e.preventDefault();
                audioContext.resume(); // Garante que o audio está ativo
                const currentVolume = parseInt(volumeSlider.value);
                // Usa a nova função de som
                createPianoSound(midiNum, currentVolume, 500, audioContext.currentTime);
                
                const noteEntry = `${fullNoteName}-${currentVolume}`;
                musicSheetTextarea.value += (musicSheetTextarea.value.trim() ? ' ' : '') + noteEntry;
                musicSheetTextarea.scrollTop = musicSheetTextarea.scrollHeight;
            });

            fullPianoKeysContainer.appendChild(noteButton);
        }
    }
    
    // --- Event Listeners da UI ---
    volumeSlider.addEventListener('input', () => volumeDisplay.textContent = volumeSlider.value);
    tempoSlider.addEventListener('input', () => tempoDisplay.textContent = tempoSlider.value);
    clearSheetBtn.addEventListener('click', () => musicSheetTextarea.value = '');

    // --- Lógica de Reprodução ---
    function playSequence(targetAudioContext = audioContext) {
        stopPlayback();
        const sequence = parseSequence(musicSheetTextarea.value);
        if (sequence.length === 0) { 
            mp3Status.textContent = "Sequência vazia."; 
            setTimeout(() => mp3Status.textContent = "", 3000); 
            return { totalDuration: 0 }; 
        }

        const bpm = parseInt(tempoSlider.value);
        const eventBaseDurationMs = (60 / bpm) * 1000;
        let cumulativeTime = 0;
        let totalDuration = 0;

        if(targetAudioContext === audioContext) scheduler = [];

        sequence.forEach((timeEvent) => {
            const eventStartTime = targetAudioContext.currentTime + (cumulativeTime / 1000) + 0.05;

            timeEvent.notesToPlay.forEach(noteDetail => {
                const noteOptions = {
                    staccato: noteDetail.staccato, accent: noteDetail.accent, legato: noteDetail.legato,
                    crescendoValue: noteDetail.crescendoValue, decrescendoValue: noteDetail.decrescendoValue
                };
                
                let noteDurationMs = eventBaseDurationMs * 0.95;
                if (noteDetail.legato) noteDurationMs *= 1.5;

                if (noteDetail.tremoloRepeats > 0) {
                    const numRepeats = noteDetail.tremoloRepeats;
                    let tremoloTotalDurationMs = eventBaseDurationMs * 0.95; 
                    if (noteDetail.staccato) tremoloTotalDurationMs *= 0.35;
                    else if (noteDetail.legato) tremoloTotalDurationMs *= 1.5;
                    
                    const subNoteDurationMs = tremoloTotalDurationMs / numRepeats;

                    for (let i = 0; i < numRepeats; i++) {
                        const tremoloNoteStartTime = eventStartTime + (i * subNoteDurationMs / 1000);
                        const subNoteOptions = { staccato: noteDetail.staccato, accent: noteDetail.accent };
                        createPianoSound(noteDetail.midi, noteDetail.volume, subNoteDurationMs * 0.90, tremoloNoteStartTime, subNoteOptions, targetAudioContext);
                    }
                } else {
                    createPianoSound(noteDetail.midi, noteDetail.volume, noteDurationMs, eventStartTime, noteOptions, targetAudioContext);
                }
                totalDuration = Math.max(totalDuration, (cumulativeTime + noteDurationMs) / 1000);
            });
            
            if(targetAudioContext === audioContext) {
                const timeoutId = setTimeout(() => {}, cumulativeTime);
                scheduler.push(timeoutId);
            }
            cumulativeTime += eventBaseDurationMs;
        });

        return { totalDuration: totalDuration + 2.0 }; // Retorna duração total com margem
    }
    
    playBtn.addEventListener('click', () => playSequence(audioContext));

    function stopPlayback() {
        if (scheduler && Array.isArray(scheduler)) {
            scheduler.forEach(timeoutId => clearTimeout(timeoutId));
        }
        scheduler = null;
        
        // Parada suave de todos os osciladores e ganhos ativos
        const now = audioContext.currentTime;
        activeSources.forEach(sEntry => {
            try {
                if (sEntry.gainNode) {
                    sEntry.gainNode.gain.cancelScheduledValues(now);
                    sEntry.gainNode.gain.setValueAtTime(sEntry.gainNode.gain.value, now);
                    sEntry.gainNode.gain.linearRampToValueAtTime(0.0001, now + 0.05);
                }
                if (sEntry.source) {
                    sEntry.source.stop(now + 0.06);
                }
            } catch (e) {}
        });
        activeSources = [];
    }
    stopBtn.addEventListener('click', stopPlayback);

    // --- Lógica de Download MP3 ---
    downloadMp3Btn.addEventListener('click', async () => {
        if (typeof lamejs === 'undefined' || !lamejs.Mp3Encoder) { 
            mp3Status.textContent = "Erro: LameJS não carregado. Cole o código na tag script."; return; 
        }
        const sequenceText = musicSheetTextarea.value;
        if (sequenceText.trim().length === 0) { 
            mp3Status.textContent = "Sequência vazia para converter."; 
            setTimeout(() => mp3Status.textContent = "", 3000); return; 
        }

        mp3Status.textContent = "Gerando MP3 Turbinado... 🎶🚀";
        playBtn.disabled = true; downloadMp3Btn.disabled = true;

        try {
            const tempCtxForDuration = new AudioContext(); // Contexto temporário só para cálculo
            const { totalDuration } = playSequence(tempCtxForDuration);
            tempCtxForDuration.close();
            
            if (totalDuration <= 0) {
                 throw new Error("A sequência não tem duração.");
            }

            const sampleRate = 44100;
            const offlineCtx = new OfflineAudioContext(1, Math.ceil(sampleRate * totalDuration), sampleRate);
            
            playSequence(offlineCtx); // Toca a sequência no contexto offline
            
            const renderedBuffer = await offlineCtx.startRendering();
            
            const mp3encoder = new lamejs.Mp3Encoder(1, sampleRate, 128); // Mono, 128kbps
            const samples = renderedBuffer.getChannelData(0);
            const sampleBlockSize = 1152;
            const mp3Data = [];

            // Converter para PCM 16-bit
            const pcm_buffer = new Int16Array(samples.length);
            for (let i = 0; i < samples.length; i++) { 
                let s = Math.max(-1, Math.min(1, samples[i]));
                pcm_buffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF; 
            }

            for (let i = 0; i < pcm_buffer.length; i += sampleBlockSize) { 
                const chunk = pcm_buffer.subarray(i, i + sampleBlockSize); 
                const mp3buf = mp3encoder.encodeBuffer(chunk); 
                if (mp3buf.length > 0) mp3Data.push(new Uint8Array(mp3buf)); 
            }
            const endMp3 = mp3encoder.flush();
            if (endMp3.length > 0) mp3Data.push(new Uint8Array(endMp3));

            const blob = new Blob(mp3Data, {type: 'audio/mp3'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); 
            a.href = url; 
            a.download = `geleia-pro_${Date.now()}.mp3`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a); 
            URL.revokeObjectURL(url);
            mp3Status.textContent = "MP3 Turbinado está pronto! 🎶";
        } catch (error) { 
            console.error("Erro ao gerar MP3:", error); 
            mp3Status.textContent = "Falha na criação do MP3: " + error.message;
        } finally { 
            playBtn.disabled = false; downloadMp3Btn.disabled = false; 
            setTimeout(() => mp3Status.textContent = "", 6000); 
        }
    });

    // --- Inicialização do Aplicativo ---
    function initialize() {
        generateFullPianoButtons();
        volumeDisplay.textContent = volumeSlider.value;
        tempoDisplay.textContent = tempoSlider.value;
        console.log("Sintetizador Geleia PRO inicializado com o novo motor de áudio.");
    }

    initialize();
});