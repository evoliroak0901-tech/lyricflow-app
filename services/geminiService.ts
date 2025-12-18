import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { LyricSegment, AnimationType, FontFamily, BackgroundEffect } from '../types';



/**


/**
 * Transcribe audio to raw text (lyrics)
 */


/**
 * Analyze lyrics to determine mood and assign styles
 * NOTE: Background effects are explicitly excluded from generation.
 */
export const analyzeMoodAndStyle = async (
  apiKey: string,
  lyrics: LyricSegment[],
  modelName: string = "gemini-1.5-flash",
  onProgress: (status: string) => void
): Promise<{
  updatedLyrics: LyricSegment[]
}> => {
  if (!lyrics || lyrics.length === 0) return { updatedLyrics: [] };

  const genAI = new GoogleGenerativeAI(apiKey);
  // Ensure we use a model that supports JSON mode if possible, but 1.5 flash does.
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: { responseMimeType: "application/json" },
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ]
  });

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

  try {
    const result = await model.generateContent([
      JSON.stringify(simplifiedLyrics),
      prompt
    ]);
    const response = await result.response;
    const jsonText = response.text();

    const parsed = JSON.parse(jsonText);
    const stylesMap = new Map((parsed.styles || []).map((s: any) => [s.id, s]));

    const updatedLyrics = lyrics.map(l => {
      const style = stylesMap.get(l.id);
      if (!style) return l;

      return {
        ...l,
        style: {
          ...l.style,
          animation: (style.animation as AnimationType) || l.style.animation,
          fontFamily: (style.font as FontFamily) || l.style.fontFamily,
          color: style.color || l.style.color,
          backgroundEffect: l.style.backgroundEffect
        }
      };
    });

    return { updatedLyrics };

  } catch (error) {
    console.error("Analysis error:", error);
    // Return original lyrics if analysis fails
    return { updatedLyrics: lyrics };
  }
};