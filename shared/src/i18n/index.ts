import { es } from "./es";
import { en, type MessageKey, type Messages } from "./en";
import { ptBR } from "./pt-BR";
import type { Locale } from "../types";

const catalogs: Record<Locale, Messages> = {
  en,
  "pt-BR": ptBR,
  es,
};

export function translate(
  locale: Locale,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const template = catalogs[locale][key] ?? catalogs.en[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));
}

export { en, es, ptBR };
export type { MessageKey, Messages };
