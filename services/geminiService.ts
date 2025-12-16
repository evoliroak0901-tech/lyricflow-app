import { GoogleGenAI, Type, HarmCategory, HarmBlockThreshold } from "@google/genai";
import { LyricSegment, AnimationType, FontFamily, BackgroundEffect } from '../types';

// Helper: Decode Audio File manually if not provided (retained for fallback analysis if needed, though less critical now)
const decodeAudioFromFile = async (file: File): Promise<AudioBuffer> => {
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  try {
    const decoded = await audioContext.decodeAudioData(arrayBuffer);
    return decoded;
  } finally {
    audioContext.close();
  }
};

// --- Main Logic ---

const fileToGenerativePart = async (
  file: File,
  onProgress: (status: string) => void
): Promise<{ inlineData: { data: string; mimeType: string } }> => {

  onProgress("データをエンコード中...");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64Data = reader.result as string;
      if (!base64Data) {
        reject(new Error("Failed to read file data"));
        return;
      }
      const base64Content = base64Data.split(',')[1];

      // Fix common mime-types for API compatibility
      let mimeType = file.type;
      if (mimeType === 'audio/mp3') mimeType = 'audio/mpeg';

      resolve({
        inlineData: {
          data: base64Content,
          mimeType: mimeType,
        },
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

export const generateLyricsFromVideo = async (
  apiKey: string,
  mediaFile: File,
  referenceLyrics?: string,
  preDecodedAudio?: AudioBuffer | null,
  onProgress: (status: string) => void = () => { }
): Promise<LyricSegment[]> => {
  try {
    const ai = new GoogleGenAI({ apiKey });

    onProgress("ファイル準備中...");

    // Simply upload the raw file. Gemini Flash 2.0 handles MP3/WAV/AAC natively and robustly.
    const mediaPart = await fileToGenerativePart(mediaFile, onProgress);

    onProgress("AIが楽曲を聴取・同期中...");

    let prompt = "";

    // ユーザーの意図に合わせてプロンプトを分岐
    if (referenceLyrics && referenceLyrics.trim().length > 0) {
      // --- ALIGNMENT MODE (強制同期モード) ---
      prompt = `
      You are an expert audio synchronizer.
      
      Task: Synchronize the provided "REFERENCE_TEXT" to the audio audio track.
      
      Requirements:
      1. Use the "REFERENCE_TEXT" exactly line by line. Do not skip lines.
      2. Listen to the audio and find the Start Time and End Time for each line.
      3. If a line is very long, insert a '\\n' character at a natural pause (Bunsetsu) to split it visually, but keep it as one object.
      4. Assign a Visual Style (animation, font, color) based on the mood of that specific part.

      REFERENCE_TEXT:
      """
      ${referenceLyrics}
      """

      Return JSON object with "lyrics" array.
      `;
    } else {
      // --- TRANSCRIPTION MODE (書き起こしモード) ---
      prompt = `
      You are an expert transcriber.

      Task: Transcribe the lyrics from the audio.
      
      Requirements:
      1. Listen to the vocals and write down the text.
      2. Provide Start Time and End Time.
      3. Assign Visual Style (animation, font, color) based on the mood.
      4. If a line is long, insert '\\n' for readability.

      Return JSON object with "lyrics" array.
      `;
    }

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash-exp",
      contents: {
        parts: [
          mediaPart,
          { text: prompt }
        ]
      },
      config: {
        responseMimeType: "application/json",
        // 安全設定を無効化（歌詞には過激な表現が含まれる可能性があるため）
        safetySettings: [
          { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ],
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            lyrics: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  text: { type: Type.STRING },
                  startTime: { type: Type.NUMBER },
                  endTime: { type: Type.NUMBER },
                  style: {
                    type: Type.OBJECT,
                    properties: {
                      animation: { type: Type.STRING },
                      fontSize: { type: Type.STRING },
                      fontFamily: { type: Type.STRING },
                      color: { type: Type.STRING },
                      backgroundEffect: { type: Type.STRING }
                    }
                  }
                },
                required: ["text", "startTime", "endTime"]
              }
            }
          }
        }
      }
    });

    onProgress("タイムライン構築中...");

    // --- JSON Cleaning ---
    let jsonText = response.text || "";
    jsonText = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();

    if (!jsonText) throw new Error("AIからの応答が空でした。");

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.error("JSON Parse Error:", e, jsonText);
      // Fallback: try to find the array bracket
      const start = jsonText.indexOf('{');
      const end = jsonText.lastIndexOf('}');
      if (start !== -1 && end !== -1) {
        try {
          parsed = JSON.parse(jsonText.substring(start, end + 1));
        } catch (e2) {
          throw new Error("AIの応答をJSONとして解析できませんでした。");
        }
      } else {
        throw new Error("AIの応答が無効な形式です。");
      }
    }

    const validateEnum = (val: string, enumObj: any, defaultVal: any) => {
      if (!val) return defaultVal;
      const normalized = val.toLowerCase().replace(/-/g, '').replace(/_/g, '');
      const match = Object.values(enumObj).find((e: any) =>
        e.toLowerCase().replace(/-/g, '').replace(/_/g, '') === normalized
      );
      return match || val;
    };

    const rawLyrics = (parsed.lyrics || []).map((l: any, index: number) => {
      const rawStyle = l.style || {};
      return {
        id: `generated-${index}-${Date.now()}`,
        text: l.text,
        startTime: typeof l.startTime === 'number' ? l.startTime : 0,
        endTime: typeof l.endTime === 'number' ? l.endTime : 0,
        style: {
          animation: validateEnum(rawStyle.animation, AnimationType, AnimationType.SLIDE_UP),
          color: rawStyle.color || '#ffffff',
          fontSize: rawStyle.fontSize || '4xl',
          position: 'center',
          fontFamily: rawStyle.fontFamily || 'display',
          backgroundEffect: BackgroundEffect.NONE,
          effects: [],
          vertical: false
        }
      };
    });

    // --- Post-processing: Remove Overlaps & Invalid Segments ---
    // Sort by startTime
    rawLyrics.sort((a: any, b: any) => a.startTime - b.startTime);

    const validLyrics: LyricSegment[] = [];

    for (let i = 0; i < rawLyrics.length; i++) {
      const current = rawLyrics[i];

      // Skip invalid duration
      if (current.endTime <= current.startTime) continue;

      // Fix overlaps with next lyric
      if (i < rawLyrics.length - 1) {
        const next = rawLyrics[i + 1];
        if (current.endTime > next.startTime) {
          // Strategy: Trim current to end exactly where next starts
          current.endTime = next.startTime;
        }
      }

      validLyrics.push(current);
    }

    return validLyrics;

  } catch (error) {
    console.error("Error generating lyrics:", error);
    throw error;
  }
};

/**
 * Analyze lyrics to determine mood and assign styles
 * NOTE: Background effects are explicitly excluded from generation.
 */
export const analyzeMoodAndStyle = async (
  apiKey: string,
  lyrics: LyricSegment[],
  onProgress: (status: string) => void
): Promise<{
  updatedLyrics: LyricSegment[]
}> => {
  if (!lyrics || lyrics.length === 0) return { updatedLyrics: [] };

  const ai = new GoogleGenAI({ apiKey });

  const simplifiedLyrics = lyrics.map((l, i) => ({
    id: l.id,
    text: l.text,
    duration: l.endTime - l.startTime
  }));

  const prompt = `
    Role: Professional Music Video Director.
    Task: Assign Kinetic Typography styles (Animation, Font, Color) for EACH line based on the mood.
    
    **INSTRUCTIONS**:
    1. **Font**: MUST Select strictly from: ['sans', 'serif', 'mincho', 'dela-gothic', 'yuji-syuku', 'horror', 'pixel', 'handwriting', 'zen-maru', 'hachi-maru'].
    2. **Animation**: Choose dynamic animation based on text meaning/intensity.
    3. **Color**: Match the emotion.
    
    Return JSON with "styles": Array of { id, animation, font, color }.
    `;

  onProgress("AIが楽曲ムードとテキスト演出を分析中...");

  let responseText = "";

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash-exp",
      contents: [
        { text: JSON.stringify(simplifiedLyrics) },
        { text: prompt }
      ],
      config: {
        responseMimeType: "application/json",
        safetySettings: [
          { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ],
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            styles: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  animation: { type: Type.STRING },
                  font: { type: Type.STRING },
                  color: { type: Type.STRING },
                  // Removed backgroundEffect
                },
                required: ["id", "animation", "font", "color"]
              }
            }
          }
        }
      }
    });
    responseText = response.text || "{}";
  } catch (e) {
    console.error("Analyze error", e);
    return { updatedLyrics: lyrics };
  }

  // Clean JSON
  responseText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
  const result = JSON.parse(responseText);
  const styleMap = new Map<string, any>(result.styles?.map((s: any) => [s.id, s]) || []);

  const updatedLyrics = lyrics.map(l => {
    const aiStyle = styleMap.get(l.id);
    if (!aiStyle) return l;

    return {
      ...l,
      style: {
        ...l.style,
        animation: aiStyle.animation as AnimationType,
        fontFamily: aiStyle.font,
        color: aiStyle.color,
        // Preserve existing effects if any
        effects: l.style.effects || [],
        backgroundEffect: BackgroundEffect.NONE
      }
    };
  });

  return {
    updatedLyrics
  };
};