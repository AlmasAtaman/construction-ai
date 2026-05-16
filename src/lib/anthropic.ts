import Anthropic from "@anthropic-ai/sdk";

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "Please add your Anthropic API key to .env.local. See README for instructions.",
    );
    this.name = "MissingApiKeyError";
  }
}

let cached: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === "your_api_key_here") {
    throw new MissingApiKeyError();
  }
  if (cached) return cached;
  cached = new Anthropic({ apiKey: key });
  return cached;
}

export function hasApiKey(): boolean {
  const key = process.env.ANTHROPIC_API_KEY;
  return !!key && key !== "your_api_key_here";
}
