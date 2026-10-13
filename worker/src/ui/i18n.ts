import en from "./i18n/en.json";
import ar from "./i18n/ar.json";
import az from "./i18n/az.json";
import ca from "./i18n/ca.json";
import cs from "./i18n/cs.json";
import da from "./i18n/da.json";
import de from "./i18n/de.json";
import el from "./i18n/el.json";
import es from "./i18n/es.json";
import fr from "./i18n/fr.json";
import hu from "./i18n/hu.json";
import id from "./i18n/id.json";
import it from "./i18n/it.json";
import ja from "./i18n/ja.json";
import ko from "./i18n/ko.json";
import nl from "./i18n/nl.json";
import pl from "./i18n/pl.json";
import pt from "./i18n/pt.json";
import pt_br from "./i18n/pt_br.json";
import ro from "./i18n/ro.json";
import ru from "./i18n/ru.json";
import sl from "./i18n/sl.json";
import sr_lat from "./i18n/sr_lat.json";
import sr from "./i18n/sr.json";
import tr from "./i18n/tr.json";
import uk from "./i18n/uk.json";
import vi from "./i18n/vi.json";
import zh_cn from "./i18n/zh_cn.json";
import zh_tw from "./i18n/zh_tw.json";
import languageList from "./i18n/languages.json";

/*
  Translations of the web interface: the PHP language files
  (includes/i18n/*.php) converted to JSON by scripts/convert-i18n.php.
  Missing keys fall back to English, then to the marker PHP printed.
*/

type Dictionary = Record<string, string>;

const DICTIONARIES: Record<string, Dictionary> = { en, ar, az, ca, cs, da, de, el, es, fr, hu, id, it, ja, ko, nl, pl, pt, pt_br, ro, ru, sl, sr_lat, sr, tr, uk, vi, zh_cn, zh_tw };

export const LANGUAGES = languageList as Record<string, { name: string; dir: "ltr" | "rtl" }>;

const CORRECTIONS: Record<string, string> = { jp: "ja", zh_hans: "zh_cn", zh_hant: "zh_tw", sr_latn: "sr_lat" };

/** Maps "de-DE", "pt-BR", "zh-Hant", ... to a language file, like PHP's resolve_language(). */
export function resolveLanguage(value: string | null | undefined): string {
  const normalized = (value ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (!normalized) return "en";
  const corrected = CORRECTIONS[normalized] ?? normalized;
  if (corrected in DICTIONARIES) return corrected;
  const base = corrected.split("_")[0]!;
  return base in DICTIONARIES ? base : "en";
}

export type Translate = (key: string) => string;

export function translator(language: string): Translate {
  const dictionary = DICTIONARIES[resolveLanguage(language)]!;
  const english = DICTIONARIES.en!;
  return (key) => dictionary[key] ?? english[key] ?? "[i18n String Missing]";
}
