import { Hono } from "hono";
import { raw } from "hono/html";
import type { AppBindings } from "../../env";
import { todayUtc } from "../../lib/dates";
import { loadUi, uiPage, type Ui, type UiCtx } from "../context";
import { asset, js, page } from "../layout";
import { loadNotificationData, NotificationsSection } from "./settings-notifications";
import { loadPaymentMethods, PaymentMethods } from "./settings-payments";

/*
  settings.php. Markup, ids, classes and inline handlers are PHP's, so
  scripts/settings.js, theme.js and notifications.js work unchanged.

  As in PHP, the account's first category ("No category") is not listed and
  its first household member (the owner) cannot be removed; in the Worker
  these are the rows with the lowest id of the account.
*/

export const routes = new Hono<AppBindings>();

interface UserRow {
  budget: number | null;
  period_budget: number | null;
  budget_period_type: string | null;
  budget_period_anchor_date: string | null;
  main_currency: number | null;
}

interface CurrencyRow {
  id: number;
  name: string;
  symbol: string;
  code: string;
  in_use: number;
}

interface CategoryRow {
  id: number;
  name: string;
  in_use: number;
}

interface MemberRow {
  id: number;
  name: string;
  email: string | null;
}

interface AiSettings {
  enabled?: number;
  type?: string;
  api_key?: string;
  url?: string;
  model?: string;
  run_schedule?: string;
}

const PAGE_STYLE = `
    .period-budget-controls {
        align-items: flex-end;
        flex-wrap: wrap;
        gap: 12px 15px;
    }

    .period-budget-controls .period-budget-field {
        display: flex;
        flex-direction: column;
        flex: 1 1 180px;
        min-width: 160px;
        gap: 8px;
    }

    .period-budget-controls .period-budget-field label {
        margin-bottom: 0;
        line-height: 1.2;
    }

    .period-budget-controls .period-budget-save {
        flex: 0 0 auto;
    }

    .period-budget-controls #budget_period_anchor_date {
        display: block;
        height: 50px;
        min-height: 50px;
    }

    @media (min-width: 421px) and (max-width: 768px) {
        .period-budget-controls .period-budget-field {
            flex: 1 1 calc(50% - 8px);
            min-width: 0;
        }

        .period-budget-controls .period-budget-save {
            width: 100%;
        }
    }

    @media (max-width: 420px) {
        .period-budget-controls .period-budget-field {
            flex: 1 1 100%;
            min-width: 0;
        }

        .period-budget-controls .period-budget-save {
            width: 100%;
        }
    }
`;

/** A translation as the content of a CSS string. */
const cssString = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/</g, "\\3c ").replace(/\n/g, " ")}'`;

/** A stored number as PHP printed it into a value attribute. */
const num = (value: number | null | undefined) => String(value ?? 0);

function Notes({ children }: { children?: unknown }) {
  return <div class="settings-notes">{children}</div>;
}

function Info({ text }: { text: string }) {
  return (
    <p>
      <i class="fa-solid fa-circle-info"></i> {text}
    </p>
  );
}

function ExternalLink({ href, title, rel }: { href: string; title: string; rel?: string }) {
  return (
    <a href={href} title={title} target="_blank" rel={rel}>
      <i class="fa-solid fa-arrow-up-right-from-square"></i>
    </a>
  );
}

function BudgetSections({ ui, user, symbol }: { ui: Ui; user: UserRow; symbol: string }) {
  const { t } = ui;
  const periodType = user.budget_period_type ?? "monthly";
  let anchor = user.budget_period_anchor_date ?? "";
  if (anchor === "1970-01-01" || !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) anchor = todayUtc();
  return (
    <>
      <section class="account-section">
        <header>
          <h2>{t("monthly_budget")}</h2>
        </header>
        <div class="account-budget">
          <div class="form-group-inline">
            <label for="monthly_budget">{symbol}</label>
            <input type="number" id="monthly_budget" name="monthly_budget" autocomplete="off" value={num(user.budget)} placeholder="Budget" />
            <input type="submit" value={t("save")} id="saveMonthlyBudget" onclick="saveMonthlyBudget()" />
          </div>
          <Notes>
            <Info text={t("monthly_budget_info")} />
          </Notes>
        </div>
      </section>

      <section class="account-section">
        <header>
          <h2>{t("period_budget")}</h2>
        </header>
        <div class="account-budget">
          <div class="form-group-inline">
            <label for="period_budget">{symbol}</label>
            <input type="number" id="period_budget" name="period_budget" autocomplete="off" value={num(user.period_budget)} placeholder="Budget" />
          </div>
          <div class="form-group-inline period-budget-controls">
            <div class="period-budget-field">
              <label for="budget_period_type">{t("budget_period")}</label>
              <select id="budget_period_type" name="budget_period_type">
                {(["weekly", "fortnightly", "monthly"] as const).map((type) => (
                  <option value={type} selected={periodType === type}>
                    {t(type)}
                  </option>
                ))}
              </select>
            </div>
            <div class="period-budget-field">
              <label for="budget_period_anchor_date">{t("budget_anchor_date")}</label>
              <input type="date" id="budget_period_anchor_date" name="budget_period_anchor_date" value={anchor} />
            </div>
            <input type="submit" value={t("save")} id="savePeriodBudget" class="period-budget-save" onclick="savePeriodBudget()" />
          </div>
          <Notes>
            <Info text={t("period_budget_info")} />
          </Notes>
        </div>
      </section>
    </>
  );
}

function HouseholdSection({ ui, members }: { ui: Ui; members: MemberRow[] }) {
  const { t } = ui;
  return (
    <section class="account-section">
      <header>
        <h2>{t("household")}</h2>
      </header>
      <div class="account-members">
        <div id="householdMembers">
          {members.map((member, index) => (
            <div class="form-group-inline" data-memberid={String(member.id)}>
              <input type="text" name="member" autocomplete="off" value={member.name} placeholder="Member" />
              {index !== 0 && <input type="text" name="email" autocomplete="off" value={member.email ?? ""} placeholder={t("email")} />}
              <button class="image-button medium" onclick={`editMember(${member.id})`} name="save" title={t("save_member")}>
                <i class="fa-solid fa-check"></i>
              </button>
              {index !== 0 ? (
                <button class="image-button medium" onclick={`removeMember(${member.id})`} title={t("delete_member")}>
                  <i class="fa-solid fa-trash-can"></i>
                </button>
              ) : (
                <button class="image-button medium disabled" title={t("cant_delete_member")}>
                  <i class="fa-solid fa-trash-can"></i>
                </button>
              )}
            </div>
          ))}
        </div>
        <div class="buttons">
          <input type="submit" value={t("add")} id="addMember" onclick="addMemberButton()" class="thin mobile-grow" />
        </div>
        <Notes>
          <Info text={t("household_info")} />
        </Notes>
      </div>
    </section>
  );
}

function CategoriesSection({ ui, categories, canTranslate }: { ui: Ui; categories: CategoryRow[]; canTranslate: boolean }) {
  const { t } = ui;
  return (
    <section class="account-section">
      <header>
        <h2>{t("categories")}</h2>
      </header>
      <div class="account-categories">
        <div id="categories" class="sortable-list">
          {categories.map((category) => (
            <div class="form-group-inline" data-categoryid={String(category.id)}>
              <div class=" drag-icon">
                <i class="fa-solid fa-grip-vertical"></i>
              </div>
              <input type="text" name="category" autocomplete="off" value={category.name} placeholder="Category" />
              <button class="image-button medium" onclick={`editCategory(${category.id})`} name="save" title={t("save_category")}>
                <i class="fa-solid fa-check"></i>
              </button>
              {category.in_use ? (
                <button class="image-button medium disabled" title={t("cant_delete_category_in_use")}>
                  <i class="fa-solid fa-trash-can"></i>
                </button>
              ) : (
                <button class="image-button medium" onclick={`removeCategory(${category.id})`} title={t("delete_category")}>
                  <i class="fa-solid fa-trash-can"></i>
                </button>
              )}
            </div>
          ))}
        </div>
        <div class="buttons">
          <input type="submit" value={t("add")} id="addCategory" onclick="addCategoryButton()" class="thin mobile-grow" />
          {canTranslate && (
            <button type="button" class="button secondary-button thin mobile-grow" id="translateCategories" onclick="translateCategories()">
              <i class="fa-solid fa-language"></i> {t("translate_categories")}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function CurrenciesSection({ ui, currencies, mainCurrency, lastUpdate }: { ui: Ui; currencies: CurrencyRow[]; mainCurrency: number | null; lastUpdate: string }) {
  const { t } = ui;
  return (
    <section class="account-section">
      <header>
        <h2>{t("currencies")}</h2>
      </header>
      <div class="account-currencies">
        <div id="currencies">
          {currencies.map((currency) => {
            const isMain = currency.id === mainCurrency;
            const canDelete = !isMain && !currency.in_use;
            return (
              <div class="form-group-inline" data-currencyid={String(currency.id)}>
                <input type="text" class="short" name="symbol" autocomplete="off" value={currency.symbol} placeholder="$" />
                <input type="text" name="currency" autocomplete="off" value={currency.name} placeholder="Currency Name" />
                <input type="text" name="code" autocomplete="off" value={currency.code} placeholder="Currency Code" disabled={!canDelete} />
                <button class="image-button medium" onclick={`editCurrency(${currency.id})`} name="save" title={t("save_currency")}>
                  <i class="fa-solid fa-check"></i>
                </button>
                {canDelete ? (
                  <button class="image-button medium" onclick={`removeCurrency(${currency.id})`} title={t("delete_currency")}>
                    <i class="fa-solid fa-trash-can"></i>
                  </button>
                ) : (
                  <button class="image-button medium disabled" title={isMain ? t("cant_delete_main_currency") : t("cant_delete_currency_in_use")}>
                    <i class="fa-solid fa-trash-can"></i>
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div class="buttons">
          <input type="submit" value={t("add")} id="addCurrency" onclick="addCurrencyButton()" class="thin mobile-grow" />
        </div>
        <Notes>
          <p>
            <i class="fa-solid fa-circle-info"></i> {t("exchange_update")} <span>{lastUpdate}</span>
          </p>
          <p>
            <i class="fa-solid fa-circle-info"></i> {t("currency_info")}{" "}
            <span>
              fixer.io <ExternalLink href="https://fixer.io/symbols" title="Currency codes" />
            </span>
          </p>
          <p>{t("currency_performance")}</p>
        </Notes>
      </div>
    </section>
  );
}

function FixerSection({ ui, apiKey, provider }: { ui: Ui; apiKey: string; provider: number }) {
  const { t } = ui;
  return (
    <section class="account-section">
      <header>
        <h2>Fixer API Key</h2>
      </header>
      <div class="account-fixer">
        <div class="form-group">
          <input type="text" name="fixer-key" id="fixerKey" autocomplete="off" value={apiKey} placeholder={t("api_key")} />
        </div>
        <div class="form-group">
          <label for="fixerProvider">{t("provider")}:</label>
          <select name="fixer-provider" id="fixerProvider">
            <option value="0" selected={provider === 0}>
              fixer.io
            </option>
            <option value="1" selected={provider === 1}>
              apilayer.com
            </option>
            <option value="2" selected={provider === 2}>
              frankfurter.dev
            </option>
          </select>
        </div>
        <div class="buttons">
          <input type="submit" value={t("save")} id="addFixerKey" onclick="addFixerKeyButton()" class="thin mobile-grow" />
        </div>
        <div class="api-usage" id="fixerUsage" style="display: none;">
          <div class="api-usage-label">
            <span>{t("monthly_requests_used")}</span>
            <span id="fixerUsageCount"></span>
          </div>
          <div class="api-usage-track">
            <span class="api-usage-fill" id="fixerUsageFill"></span>
          </div>
        </div>
        <Notes>
          <p>
            <i class="fa-solid fa-circle-info"></i>
            {t("fixer_info")}
          </p>
          <p>
            {t("get_key")}:{" "}
            <span>
              https://fixer.io/ <ExternalLink href="https://fixer.io/#pricing_plan" title={t("get_free_fixer_api_key")} />
            </span>
          </p>
          <p>
            {t("get_key_alternative")}{" "}
            <span>
              https://apilayer.com <ExternalLink href="https://apilayer.com/marketplace/fixer-api" title="Get free fixer api key" />
            </span>
          </p>
          <p>
            {t("no_api_key_provider")}{" "}
            <span>
              https://frankfurter.dev <ExternalLink href="https://frankfurter.dev" title="Frankfurter" />
            </span>
          </p>
        </Notes>
      </div>
    </section>
  );
}

function GoogleSearchSection({ ui, apiKey }: { ui: Ui; apiKey: string }) {
  const { t } = ui;
  return (
    <section class="account-section">
      <header>
        <h2>Google Search (SerpAPI)</h2>
      </header>
      <div class="account-google-search">
        <div class="form-group">
          <input type="text" name="google-search-key" id="googleSearchKey" autocomplete="off" value={apiKey} placeholder={t("api_key")} />
        </div>
        <div class="buttons">
          <input type="submit" value={t("save")} id="saveGoogleSearch" onclick="saveGoogleSearchButton()" class="thin mobile-grow" />
        </div>
        <div class="api-usage" id="googleSearchUsage" style="display: none;">
          <div class="api-usage-label">
            <span>{t("monthly_searches_used")}</span>
            <span id="googleSearchUsageCount"></span>
          </div>
          <div class="api-usage-track">
            <span class="api-usage-fill" id="googleSearchUsageFill"></span>
          </div>
        </div>
        <Notes>
          <Info text={t("google_search_info")} />
          <p>
            {t("get_key")}:{" "}
            <span>
              https://serpapi.com/ <ExternalLink href="https://serpapi.com/users/sign_up?plan=free" title="SerpAPI" rel="noreferrer" />
            </span>
          </p>
        </Notes>
      </div>
    </section>
  );
}

function AiSection({ ui, ai }: { ui: Ui; ai: AiSettings }) {
  const { t } = ui;
  const type = ai.type;
  const urlVisible = type === "ollama" || type === "openai-compatible";
  const canRun = Boolean(ai.model) && Number(ai.enabled) === 1;
  const providers: [string, string][] = [
    ["chatgpt", "ChatGPT"],
    ["gemini", "Gemini"],
    ["openrouter", "OpenRouter"],
    ["ollama", "Local Ollama"],
    ["openai-compatible", "OpenAI Compatible"],
  ];
  const schedules: [string, string][] = [
    ["manual", "manually"],
    ["weekly", "Weekly"],
    ["monthly", "Monthly"],
  ];
  return (
    <section class="account-section">
      <header>
        <h2>{t("ai_recommendations")}</h2>
      </header>
      <div class="account-ai-settings">
        <div class="form-group-inline">
          <input type="checkbox" id="ai_enabled" name="ai_enabled" checked={Boolean(ai.enabled)} />
          <label for="ai_enabled" class="capitalize">
            {t("enabled")}
          </label>
        </div>
        <div class="form-group">
          <label for="ai_type">{t("provider")}:</label>
          <select id="ai_type" name="ai_type" onchange="toggleAiInputs()">
            {providers.map(([value, label]) => (
              <option value={value} selected={type === value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div class="form-group-inline" id="ai_url_group" style={urlVisible ? undefined : "display:none"}>
          <input
            type="text"
            id="ai_ollama_host"
            name="ai_ollama_host"
            autocomplete="off"
            placeholder={type === "openai-compatible" ? "http://localhost:11434/v1" : "http://localhost:11434"}
            value={ai.url ?? ""}
          />
          <button type="button" id="fetchModelsButton2" class={`button thin ${type !== "ollama" ? "hidden" : ""}`} onclick="fetch_ai_models()">
            {t("test")}
          </button>
        </div>
        <div class="form-group-inline">
          <input
            type="password"
            id="ai_api_key"
            name="ai_api_key"
            autocomplete="off"
            class={type === "ollama" ? "hidden" : ""}
            placeholder={t("api_key")}
            value={ai.api_key ?? ""}
          />
          <button type="button" id="fetchModelsButton" class="button thin" onclick="fetch_ai_models()">
            {t("test")}
          </button>
        </div>
        <div class="form-group">
          <label for="ai_model">{t("ai_model")}:</label>
          <select id="ai_model" name="ai_model">
            <option value="">{t("select_ai_model")}</option>
            {ai.model ? (
              <option value={ai.model} selected>
                {ai.model}
              </option>
            ) : null}
          </select>
        </div>
        <div class="form-group">
          <label for="ai_run_schedule" class="flex">
            {t("run_schedule")}:
          </label>
          <select id="ai_run_schedule" name="ai_run_schedule">
            {schedules.map(([value, label]) => (
              <option value={value} selected={ai.run_schedule === value}>
                {t(label)}
              </option>
            ))}
          </select>
        </div>
        <div class="buttons wrap mobile-reverse">
          <input
            type="button"
            id="runAiRecommendations"
            class={`secondary-button thin mobile-grow-force ${!canRun ? "hidden" : ""}`}
            onclick="runAiRecommendations()"
            value={t("generate_recommendations")}
          />
          <div id="aiSpinner" class="spinner ai-spinner hidden"></div>
          <input type="submit" class="thin mobile-grow-force" value={t("save")} id="saveAiSettings" onclick="saveAiSettingsButton()" />
        </div>
        <Notes>
          <p>
            <i class="fa-solid fa-circle-info"></i>
            {t("ai_recommendations_info")}
          </p>
          <p>
            <i class="fa-solid fa-circle-info"></i>
            {t("may_take_time")}
          </p>
          <p>
            <i class="fa-solid fa-circle-info"></i>
            {t("recommendations_visible_on_dashboard")}
          </p>
        </Notes>
      </div>
    </section>
  );
}

function PaymentsSection({ ui, children }: { ui: Ui; children?: unknown }) {
  const { t } = ui;
  return (
    <section class="account-section">
      <header>
        <h2>{t("payment_methods")}</h2>
      </header>
      <div class="payments-list" id="payments-list">
        {children}
      </div>
      <Notes>
        <Info text={t("payment_methods_info")} />
        <Info text={t("rename_payment_methods_info")} />
      </Notes>
      <header>
        <h2 class="second-header">{t("add_custom_payment")}</h2>
      </header>
      <div>
        <form id="payments-form">
          <div class="form-group-inline">
            <input
              type="text"
              name="paymentname"
              id="paymentname"
              autocomplete="off"
              placeholder={t("payment_method_name")}
              onchange="setSearchButtonStatus()"
              onkeypress="this.onchange();"
              onpaste="this.onchange();"
              oninput="this.onchange();"
            />
            <label for="paymenticon" class="icon-preview">
              <img src="" alt={t("logo_preview")} id="form-icon" />
            </label>
            <div class="form-icon-search">
              <input
                type="file"
                id="paymenticon"
                name="paymenticon"
                accept="image/jpeg, image/png, image/gif, image/webp"
                onchange="handleFileSelect(event)"
                class="hidden-input"
              />
              <input type="hidden" id="icon-url" name="icon-url" />
              <div id="icon-search-button" class="image-button medium disabled" title={t("search_logo")} onclick="searchPaymentIcon()">
                <i class="fa-solid fa-magnifying-glass"></i>
              </div>
              <div class="icon-search-backdrop" id="icon-search-backdrop" onclick="closeIconSearch()"></div>
              <div id="icon-search-results" class="icon-search">
                <button type="button" class="close-icon-search" onclick="closeIconSearch()" title={t("cancel")}>
                  <i class="fa-solid fa-xmark"></i>
                </button>
                <header>
                  <h3 id="icon-search-title" data-title={t("web_search")}>
                    {t("web_search")}
                  </h3>
                </header>
                <div id="icon-search-images"></div>
              </div>
            </div>
            <input type="button" class="button thin" id="add-payment-button" value="+" title={t("add")} onclick="addPaymentMethod()" />
          </div>
        </form>
      </div>
    </section>
  );
}

function ThemeSection({ ui }: { ui: Ui }) {
  const { t } = ui;
  const dark = ui.settings.dark_theme;
  const color = ui.settings.color_theme;
  const custom = ui.customColors;
  const themeButtons: [number, string, string, string][] = [
    [0, "theme-light", "fa-solid fa-sun", "light_theme"],
    [1, "theme-dark", "fa-solid fa-moon", "dark_theme"],
    [2, "theme-automatic", "fa-solid fa-circle-half-stroke", "automatic"],
  ];
  const pickers: [string, string, string | undefined][] = [
    ["mainColor", "main_color", custom?.main_color],
    ["accentColor", "accent_color", custom?.accent_color],
    ["hoverColor", "hover_color", custom?.hover_color],
  ];
  return (
    <section class="account-section">
      <header>
        <h2>{t("theme_settings")}</h2>
      </header>
      <div class="account-settings-theme">
        <div>
          <h3>{t("theme")}</h3>
          <div class="form-group-inline wrap">
            {themeButtons.map(([value, id, icon, label]) => (
              <button type="button" class={`dark-theme-button capitalize ${Number(dark) === value ? "selected" : ""}`} onclick={`setDarkTheme('${value}')`} id={id}>
                <i class={icon}></i> {t(label)}
              </button>
            ))}
          </div>
        </div>
        <div>
          <form class="theme-selector">
            <h3>{t("colors")}</h3>
            <div class="form-group-inline wrap">
              {["blue", "green", "red", "yellow", "purple"].map((name) => (
                <div class="theme">
                  <input type="radio" name="theme" id={`theme-${name}`} value={name} onclick={`setTheme('${name}')`} checked={color === name} />
                  <label for={`theme-${name}`} class={`theme-preview ${name} ${color === name ? "is-selected" : ""}`}>
                    <span class="main-color"></span>
                    <span class="accent-color"></span>
                    <span class="hover-color"></span>
                  </label>
                </div>
              ))}
            </div>
          </form>
        </div>
        <div>
          <h3>{t("custom_colors")}</h3>
          <div class="custom-colors wrap">
            {pickers.map(([id, label, value]) => (
              <div class="form-group-inline mobile-grow color-picker-button">
                <input type="color" id={id} name={id} value={value ?? "#FFFFFF"} class="color-picker fa-solid fa-eye-dropper" />
                <label for={id}>{t(label)}</label>
              </div>
            ))}
          </div>
          <div class="custom-colors wrap">
            <input type="button" value={t("reset_custom_colors")} onclick="resetCustomColors()" class="secondary-button thin mobile-grow" id="reset-colors" />
            <input type="button" value={t("save_custom_colors")} onclick="saveCustomColors()" class="buton thin mobile-grow" id="save-colors" />
          </div>
        </div>
        <div>
          <h3>{t("custom_css")}</h3>
          <div class="form-group">
            <div class="form-group-inline">
              <textarea name="customCss" id="customCss" placeholder={t("custom_css")} class="thin">
                {ui.customCss}
              </textarea>
            </div>
            <div class="form-group-inline">
              <input type="button" value={t("save_custom_css")} onclick="saveCustomCss()" class="buton thin mobile-grow" id="save-css" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Checkbox({ id, onChange, checked, label, disabled }: { id: string; onChange: string; checked: boolean; label: string; disabled?: boolean }) {
  return (
    <div>
      <div class="form-group-inline">
        <input type="checkbox" id={id} name={id} onchange={onChange} checked={checked} disabled={disabled} />
        <label for={id}>{label}</label>
      </div>
    </div>
  );
}

function DisplaySection({ ui, ratesConfigured }: { ui: Ui; ratesConfigured: boolean }) {
  const { t } = ui;
  const s = ui.settings;
  const limit = [3, 5, 10, 20].includes(Number(s.upcoming_payments_limit)) ? Number(s.upcoming_payments_limit) : 3;
  return (
    <>
      <section class="account-section">
        <header>
          <h2>{t("display_settings")}</h2>
        </header>
        <div class="account-settings-list">
          <h3>{t("price")}</h3>
          <Checkbox id="monthlyprice" onChange="setShowMonthlyPrice()" checked={Boolean(s.monthly_price)} label={t("calculate_monthly_price")} />
          <Checkbox
            id="convertcurrency"
            onChange="setConvertCurrency()"
            checked={Boolean(s.convert_currency)}
            disabled={!ratesConfigured}
            label={t("convert_prices")}
          />
          <Checkbox id="showoriginalprice" onChange="setShowOriginalPrice()" checked={Boolean(s.show_original_price)} label={t("show_original_price")} />
          <div>
            <div class="form-group">
              <label for="upcomingpaymentslimit">{t("upcoming_payments_to_show")}</label>
              <select id="upcomingpaymentslimit" name="upcomingpaymentslimit" onchange="setUpcomingPaymentsLimit()">
                {[3, 5, 10, 20].map((n) => (
                  <option value={String(n)} selected={limit === n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <h3>{t("experience")}</h3>
          <div>
            <div class="form-group-inline">
              <input type="checkbox" id="mobilenavigation" name="mobilenavigation" onchange="setMobileNavigation()" checked={Boolean(s.mobile_nav)} />
              <label for="mobilenavigation">{t("use_mobile_navigation_bar")}</label>
            </div>
            <div class="mobile-nav-image"></div>
          </div>
          <Checkbox
            id="showsubscriptionprogress"
            onChange="setShowSubscriptionProgress()"
            checked={Boolean(s.show_subscription_progress)}
            label={t("show_subscription_progress")}
          />
          <Checkbox id="weekstartssunday" onChange="setWeekStartsSunday()" checked={Boolean(s.week_starts_sunday)} label={t("week_starts_on_sunday")} />
          <h3>{t("disabled_subscriptions")}</h3>
          <Checkbox
            id="disabledtobottom"
            onChange="setDisabledToBottom()"
            checked={Boolean(s.disabled_to_bottom)}
            label={t("show_disabled_subscriptions_at_the_bottom")}
          />
          <Checkbox id="hidedisabled" onChange="setHideDisabled()" checked={Boolean(s.hide_disabled)} label={t("hide_disabled_subscriptions")} />
        </div>
      </section>

      <section class="account-section">
        <header>
          <h2>{t("experimental_settings")}</h2>
        </header>
        <div class="account-settings-list">
          <Checkbox id="removebackground" onChange="setRemoveBackground()" checked={Boolean(s.remove_background)} label={t("remove_background")} />
        </div>
        <Notes>
          <Info text={t("remove_background_info")} />
          <p>
            <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> {t("experimental_info")}
          </p>
        </Notes>
      </section>
    </>
  );
}

routes.get("/settings.php", uiPage, async (c: UiCtx) => {
  const ui = await loadUi(c);
  const { t } = ui;
  const db = c.env.DB;
  const userId = c.get("user").id;

  const [userRes, currencyRes, memberRes, categoryRes, lastRes, fixerRes, googleRes, aiTable] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT budget, period_budget, budget_period_type, budget_period_anchor_date, main_currency FROM user WHERE id = ?").bind(userId),
    db
      .prepare(
        `SELECT c.id, c.name, c.symbol, c.code,
                EXISTS (SELECT 1 FROM subscriptions s WHERE s.currency_id = c.id AND s.user_id = c.user_id) AS in_use
           FROM currencies c WHERE c.user_id = ? ORDER BY c.id`,
      )
      .bind(userId),
    db.prepare("SELECT id, name, email FROM household WHERE user_id = ? ORDER BY id").bind(userId),
    db
      .prepare(
        `SELECT c.id, c.name,
                EXISTS (SELECT 1 FROM subscriptions s WHERE s.category_id = c.id AND s.user_id = c.user_id) AS in_use
           FROM categories c
          WHERE c.user_id = ?1 AND c.id != (SELECT MIN(id) FROM categories WHERE user_id = ?1)
          ORDER BY c."order", c.id`,
      )
      .bind(userId),
    db.prepare("SELECT date FROM last_exchange_update WHERE user_id = ?").bind(userId),
    db.prepare("SELECT api_key, provider FROM fixer WHERE user_id = ?").bind(userId),
    db.prepare("SELECT api_key FROM google_search WHERE user_id = ?").bind(userId),
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_settings'"),
  ]);

  const user = userRes!.results[0] as unknown as UserRow;
  const currencies = currencyRes!.results as unknown as CurrencyRow[];
  const symbol = currencies.find((cur) => cur.id === user.main_currency)?.symbol ?? "";
  const fixer = fixerRes!.results[0] as { api_key: string; provider: number } | undefined;
  const provider = fixer ? Number(fixer.provider) : 0;
  // Frankfurter needs no key, so a provider row is what makes conversion possible.
  const ratesConfigured = Boolean(fixer && (fixer.api_key || provider === 2));
  // AI recommendations are not part of the Worker yet; with no table the section renders unconfigured.
  const ai: AiSettings = aiTable?.results.length
    ? ((await db.prepare("SELECT * FROM ai_settings WHERE user_id = ? LIMIT 1").bind(userId).first<AiSettings>()) ?? {})
    : {};
  const canTranslate = Boolean(ai.enabled) && Boolean(ai.model) && ui.lang !== "en";

  const [notifications, payments] = await Promise.all([loadNotificationData(c), loadPaymentMethods(db, userId)]);

  const body = (
    <>
      <script src="scripts/libs/sortable.min.js"></script>
      <style>{raw(`
    .logo-preview:after {
        content: ${cssString(t("upload_logo"))};
    }
${PAGE_STYLE}`)}</style>
      <section class="contain settings">
        <BudgetSections ui={ui} user={user} symbol={symbol} />
        <HouseholdSection ui={ui} members={memberRes!.results as unknown as MemberRow[]} />
        <NotificationsSection ui={ui} data={notifications} />
        <CategoriesSection ui={ui} categories={categoryRes!.results as unknown as CategoryRow[]} canTranslate={canTranslate} />
        <CurrenciesSection ui={ui} currencies={currencies} mainCurrency={user.main_currency} lastUpdate={String(lastRes!.results[0]?.date ?? "")} />
        <FixerSection ui={ui} apiKey={fixer?.api_key ?? ""} provider={provider} />
        <GoogleSearchSection ui={ui} apiKey={String(googleRes!.results[0]?.api_key ?? "")} />
        <AiSection ui={ui} ai={ai} />
        <PaymentsSection ui={ui}>
          <PaymentMethods t={t} payments={payments} />
        </PaymentsSection>
        <ThemeSection ui={ui} />
        <DisplaySection ui={ui} ratesConfigured={ratesConfigured} />
      </section>
      <script>
        {raw(`
    // The raw applicationServerKey bytes pushManager.subscribe() needs.
    window.vapidPublicKey = ${js(notifications.vapidPublicKey)};
`)}
      </script>
      <script src={asset(ui, "scripts/settings.js")}></script>
      <script src={asset(ui, "scripts/theme.js")}></script>
      <script src={asset(ui, "scripts/notifications.js")}></script>
    </>
  );
  return page(c, ui, "settings", body);
});
