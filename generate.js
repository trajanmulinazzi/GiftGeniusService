import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const client = new Anthropic({
  apiKey: process.env.Anthropic_API_Key,
});

export const Generate = async (profile, liked_items, disliked_items) => {
  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    system: `You are a gift idea generator. Your objective is to generate 5 gift ideas. 
     You must follow these rules:
     1) Each idea should be concise, containing only the key word to find the item on Amazon. 
     2) You will be provided a user profile to help you tailor your ideas. 
     3) Use entries in liked_items as guidance, but try not to repeat similar gift ideas.
     4) Avoid generating gift ideas that are similar to disliked_items. 
     5) If applicable, do research on what's trending.`,
    messages: [
      {
        role: "user",
        content: JSON.stringify(
          { profile, liked_items, disliked_items },
          null,
          2,
        ),
      },
    ],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            ideas: { type: "array" },
          },
          required: ["ideas"],
          additionalProperties: false,
        },
      },
    },
  });

  return JSON.parse(response.content[0].text);
};
