import type { Ui, UiCtx } from "../context";
import { getVapidKeys } from "../../lib/webpush";
import { MASK, SECRET_FIELDS, type ChannelName } from "../../notifications/channels";

/*
  The notifications section of settings.php. The markup (ids, inline
  handlers, data-type) is PHP's, so scripts/notifications.js works unchanged.

  PHP read one table per channel; the Worker keeps one notification_channels
  row per user and channel with a JSON config (see notifications/channels.ts).
  E-mail goes out through the instance's Resend sender, so the SMTP inputs of
  the e-mail block are still rendered (notifications.js reads them) but hidden.
*/

type Config = Record<string, unknown>;

export interface NotificationData {
  days: number;
  periodSummary: boolean;
  channels: Map<string, { enabled: boolean; config: Config }>;
  pushSubscriptions: { id: number; user_agent: string | null }[];
  vapidPublicKey: string;
}

const DEFAULT_WEBHOOK_PAYLOAD = `
{
    "name": "{{subscription_name}}",
    "price": "{{subscription_price}}",
    "currency": "{{subscription_currency}}",
    "category": "{{subscription_category}}",
    "date": "{{subscription_date}}",
    "payer": "{{subscription_payer}}",
    "days": "{{subscription_days_until_payment}}",
    "notes": "{{subscription_notes}}",
    "url": "{{subscription_url}}"
}`;

export async function loadNotificationData(c: UiCtx): Promise<NotificationData> {
  const db = c.env.DB;
  const userId = c.get("user").id;
  const [settings, channels, push] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT days, period_summary_at_period_start FROM notification_settings WHERE user_id = ?").bind(userId),
    db.prepare("SELECT channel, enabled, config FROM notification_channels WHERE user_id = ?").bind(userId),
    db.prepare("SELECT id, user_agent FROM push_subscriptions WHERE user_id = ? ORDER BY id").bind(userId),
  ]);
  const row = settings?.results[0] as { days: number; period_summary_at_period_start: number } | undefined;
  const map = new Map<string, { enabled: boolean; config: Config }>();
  for (const r of channels?.results ?? []) {
    let config: Config = {};
    try {
      const parsed = JSON.parse(String(r.config ?? "{}"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Config;
    } catch {
      config = {};
    }
    map.set(String(r.channel), { enabled: Boolean(r.enabled), config });
  }
  let vapidPublicKey = "";
  try {
    vapidPublicKey = (await getVapidKeys(db)).publicKey;
  } catch (error) {
    console.warn("VAPID keys unavailable", error);
  }
  return {
    days: row ? Number(row.days) : 1,
    periodSummary: Boolean(row?.period_summary_at_period_start),
    channels: map,
    pushSubscriptions: (push?.results ?? []) as { id: number; user_agent: string | null }[],
    vapidPublicKey,
  };
}

function Header({ type, icon, title }: { type: string; icon: string; title: string }) {
  return (
    <header class="account-notification-section-header" onclick={`openNotificationsSettings('${type}');`}>
      <h3>
        <i class={icon}></i> {title}
      </h3>
    </header>
  );
}

function Enabled({ ui, id, checked }: { ui: Ui; id: string; checked: boolean }) {
  return (
    <div class="form-group-inline">
      <input type="checkbox" id={id} name={id} checked={checked} />
      <label for={id} class="capitalize">
        {ui.t("enabled")}
      </label>
    </div>
  );
}

function Text({ id, placeholder, value, type = "text", className }: { id: string; placeholder: string; value: string; type?: string; className?: string }) {
  return <input type={type} name={id} id={id} autocomplete="off" placeholder={placeholder} value={value} class={className} />;
}

function Field(props: { id: string; placeholder: string; value: string; type?: string }) {
  return (
    <div class="form-group-inline">
      <Text {...props} />
    </div>
  );
}

function Buttons({ ui, name, test, save }: { ui: Ui; name: string; test: string; save: string }) {
  return (
    <div class="buttons">
      <input type="button" class="secondary-button thin mobile-grow" value={ui.t("test")} id={`testNotifications${name}`} onclick={test} />
      <input type="submit" class="thin mobile-grow" value={ui.t("save")} id={`saveNotifications${name}`} onclick={save} />
    </div>
  );
}

function IgnoreSsl({ ui, id, checked, groupClass = "form-group-inline" }: { ui: Ui; id: string; checked: boolean; groupClass?: string }) {
  return (
    <div class={groupClass}>
      <input type="checkbox" id={id} name={id} checked={checked} />
      <label for={id}>{ui.t("ignore_ssl_errors")}</label>
    </div>
  );
}

export function NotificationsSection({ ui, data }: { ui: Ui; data: NotificationData }) {
  const { t } = ui;
  const channel = (name: string) => data.channels.get(name) ?? { enabled: false, config: {} as Config };
  const str = (config: Config, key: string, fallback = "") => {
    const value = config[key];
    return value === undefined || value === null ? fallback : String(value);
  };
  const flag = (config: Config, key: string) => Boolean(config[key]) && config[key] !== "0";
  // Stored secrets are shown masked; the save endpoints keep the stored value when they get the mask back.
  const secret = (name: ChannelName, key: string) => {
    const value = str(channel(name).config, key);
    return value && SECRET_FIELDS[name]?.includes(key) ? MASK : value;
  };

  const email = channel("email");
  const discord = channel("discord");
  const gotify = channel("gotify");
  const pushover = channel("pushover");
  const telegram = channel("telegram");
  const pushplus = channel("pushplus");
  const mattermost = channel("mattermost");
  const ntfy = channel("ntfy");
  const push = channel("push");
  const serverchan = channel("serverchan");
  const webhook = channel("webhook");
  const webhookMethod = str(webhook.config, "request_method", "POST");
  const encryption = str(email.config, "encryption", "tls");
  // SMTP is not used by the Worker (mail goes through the instance's Resend sender).
  const hidden = "display: none;";

  return (
    <section class="account-section">
      <header>
        <h2>{t("notifications")}</h2>
      </header>
      <div class="account-notifications">
        <section>
          <label for="days">{t("notify_me")}:</label>
          <div class="form-group-inline">
            <select name="days" id="days">
              <option value="0" selected={data.days === 0}>
                {t("on_due_date")}
              </option>
              <option value="1" selected={data.days === 1}>
                1 {t("day_before")}
              </option>
              {[2, 3, 4, 5, 6, 7].map((i) => (
                <option value={String(i)} selected={data.days === i}>
                  {i} {t("day_before")}
                </option>
              ))}
            </select>
            <input type="submit" class="thin" value={t("save")} id="saveNotifications" onclick="saveNotifications()" />
          </div>
          <div class="form-group-inline">
            <input type="checkbox" id="period_summary_at_period_start" name="period_summary_at_period_start" checked={data.periodSummary} />
            <label for="period_summary_at_period_start">{t("send_period_summary_at_period_start")}</label>
          </div>
        </section>

        <section class="account-notifications-section">
          <Header type="email" icon="fa-solid fa-envelope" title={t("email")} />
          <div class="account-notification-section-settings" data-type="email">
            <Enabled ui={ui} id="emailenabled" checked={email.enabled} />
            <div class="form-group-inline" style={hidden}>
              <Text id="smtpaddress" placeholder={t("smtp_address")} value={str(email.config, "smtp_address")} />
              <Text id="smtpport" placeholder={t("port")} value={str(email.config, "smtp_port", "587")} className="one-third" />
            </div>
            <div class="form-group-inline" style={hidden}>
              {(["none", "tls", "ssl"] as const).map((value) => (
                <div>
                  <input type="radio" name="encryption" id={`encryption${value}`} value={value} checked={encryption === value} />
                  <label for={`encryption${value}`}>{t(value)}</label>
                </div>
              ))}
            </div>
            <div class="form-group-inline" style={hidden}>
              <Text id="smtpusername" placeholder={t("smtp_username")} value={str(email.config, "smtp_username")} />
            </div>
            <div class="form-group-inline" style={hidden}>
              <Text id="smtppassword" type="password" placeholder={t("smtp_password")} value={str(email.config, "smtp_password")} />
            </div>
            <div class="form-group-inline" style={hidden}>
              <Text id="fromemail" placeholder={t("from_email")} value={str(email.config, "from_email")} />
            </div>
            <label for="otheremails">{t("send_to_other_emails")}</label>
            <Field id="otheremails" placeholder={t("other_emails_placeholder")} value={str(email.config, "other_emails")} />
            <Buttons ui={ui} name="Email" test="testNotificationEmailButton()" save="saveNotificationsEmailButton()" />
          </div>
        </section>

        <section class="account-notifications-section">
          <Header type="discord" icon="fa-brands fa-discord" title={t("discord")} />
          <div class="account-notification-section-settings" data-type="discord">
            <Enabled ui={ui} id="discordenabled" checked={discord.enabled} />
            <Field id="discordurl" placeholder={t("webhook_url")} value={str(discord.config, "webhook_url")} />
            <Field id="discordbotusername" placeholder={t("discord_bot_username")} value={str(discord.config, "bot_username")} />
            <Field id="discordbotavatar" placeholder={t("discord_bot_avatar_url")} value={str(discord.config, "bot_avatar_url")} />
            <Buttons ui={ui} name="Discord" test="testNotificationsDiscordButton()" save="saveNotificationsDiscordButton()" />
          </div>
        </section>

        <section class="account-notifications-section">
          <Header type="gotify" icon="fa-solid fa-envelopes-bulk" title={t("gotify")} />
          <div class="account-notification-section-settings" data-type="gotify">
            <Enabled ui={ui} id="gotifyenabled" checked={gotify.enabled} />
            <Field id="gotifyurl" placeholder={t("url")} value={str(gotify.config, "url")} />
            <Field id="gotifytoken" placeholder={t("token")} value={secret("gotify", "token")} />
            <IgnoreSsl ui={ui} id="gotifyignoressl" checked={flag(gotify.config, "ignore_ssl")} />
            <Buttons ui={ui} name="Gotify" test="testNotificationsGotifyButton()" save="saveNotificationsGotifyButton()" />
          </div>
        </section>

        <section class="account-notifications-section">
          <Header type="pushover" icon="fa-brands fa-pinterest-p" title={t("pushover")} />
          <div class="account-notification-section-settings" data-type="pushover">
            <Enabled ui={ui} id="pushoverenabled" checked={pushover.enabled} />
            <Field id="pushoveruserkey" placeholder={t("pushover_user_key")} value={str(pushover.config, "user_key")} />
            <Field id="pushovertoken" placeholder={t("token")} value={secret("pushover", "token")} />
            <Buttons ui={ui} name="Pushover" test="testNotificationsPushoverButton()" save="saveNotificationsPushoverButton()" />
          </div>
        </section>

        <section class="account-notifications-section">
          <Header type="telegram" icon="fa-solid fa-paper-plane" title={t("telegram")} />
          <div class="account-notification-section-settings" data-type="telegram">
            <Enabled ui={ui} id="telegramenabled" checked={telegram.enabled} />
            <Field id="telegrambottoken" placeholder={t("telegram_bot_token")} value={secret("telegram", "bot_token")} />
            <Field id="telegramchatid" placeholder={t("telegram_chat_id")} value={str(telegram.config, "chat_id")} />
            <Buttons ui={ui} name="Telegram" test="testNotificationsTelegramButton()" save="saveNotificationsTelegramButton()" />
          </div>
        </section>

        <section class="account-notifications-section">
          <Header type="pushplus" icon="fa-solid fa-bell" title={t("pushplus")} />
          <div class="account-notification-section-settings" data-type="pushplus">
            <Enabled ui={ui} id="pushplusenabled" checked={pushplus.enabled} />
            <Field id="pushplustoken" placeholder={t("pushplus_token")} value={secret("pushplus", "token")} />
            <Buttons ui={ui} name="PushPlus" test="testNotificationsPushPlusButton()" save="saveNotificationsPushPlusButton()" />
          </div>
        </section>

        <section class="account-notifications-section">
          <Header type="mattermost" icon="fa-solid fa-gauge-simple-high" title={t("mattermost")} />
          <div class="account-notification-section-settings" data-type="mattermost">
            <Enabled ui={ui} id="mattermostenabled" checked={mattermost.enabled} />
            <div class="form-group-inline">
              <input type="text" name="mattermostwebhookurl" id="mattermostwebhookurl" placeholder={t("mattermost_webhook_url")} value={str(mattermost.config, "webhook_url")} />
            </div>
            <div class="form-group-inline">
              <input type="text" name="mattermostbotusername" id="mattermostbotusername" placeholder={t("mattermost_bot_username")} value={str(mattermost.config, "bot_username")} />
            </div>
            <div class="form-group-inline">
              <input type="text" name="mattermostboticonemoji" id="mattermostboticonemoji" placeholder={t("mattermost_bot_icon_emoji")} value={str(mattermost.config, "bot_icon_emoji")} />
            </div>
            <Buttons ui={ui} name="Mattermost" test="testNotificationsMattermostButton()" save="saveNotificationsMattermostButton()" />
          </div>
        </section>

        <section class="account-notifications-section">
          <header class="account-notification-section-header" onclick="openNotificationsSettings('ntfy');">
            <h3>
              <i class="fa-solid fa-terminal"></i> Ntfy
            </h3>
          </header>
          <div class="account-notification-section-settings" data-type="ntfy">
            <Enabled ui={ui} id="ntfyenabled" checked={ntfy.enabled} />
            <Field id="ntfyhost" placeholder={t("host")} value={str(ntfy.config, "host")} />
            <Field id="ntfytopic" placeholder={t("topic")} value={str(ntfy.config, "topic")} />
            <div class="form-group-inline">
              <textarea class="thin" name="ntfyheaders" id="ntfyheaders" placeholder={t("custom_headers")}>
                {secret("ntfy", "headers")}
              </textarea>
            </div>
            <IgnoreSsl ui={ui} id="ntfyignoressl" checked={flag(ntfy.config, "ignore_ssl")} groupClass="form-grpup-inline" />
            <Buttons ui={ui} name="Ntfy" test="testNotificationsNtfyButton()" save="saveNotificationsNtfyButton()" />
          </div>
        </section>

        <section class="account-notifications-section">
          <header class="account-notification-section-header" onclick="openNotificationsSettings('push');">
            <h3>
              <i class="fa-solid fa-bell"></i> {t("push_notifications")}
            </h3>
          </header>
          <div class="account-notification-section-settings" data-type="push">
            <Enabled ui={ui} id="pushenabled" checked={push.enabled} />
            <div class="push-devices-list" id="pushDevicesList">
              {data.pushSubscriptions.length === 0 ? (
                <p id="noPushDevices" class="push-no-devices">
                  {t("no_devices_registered")}
                </p>
              ) : (
                data.pushSubscriptions.map((s) => (
                  <div class="push-device-row" data-subscriptionid={String(s.id)}>
                    <span class="push-device-name">{s.user_agent ? s.user_agent : t("unknown_device")}</span>
                    <button type="button" class="secondary-button thin" onclick={`removePushSubscriptionButton(${Number(s.id)})`}>
                      {t("delete")}
                    </button>
                  </div>
                ))
              )}
            </div>
            <div class="settings-notes">
              <p>
                <i class="fa-solid fa-circle-info"></i> {t("push_notifications_info")}
              </p>
            </div>
            <div class="buttons">
              <input type="button" class="secondary-button thin mobile-grow" value={t("test")} id="testNotificationsPush" onclick="testNotificationsPushButton()" />
              <input
                type="button"
                class="secondary-button thin mobile-grow"
                value={t("enable_on_this_device")}
                id="subscribePushButton"
                onclick="subscribePushButtonClick()"
              />
              <input type="submit" class="thin mobile-grow" value={t("save")} id="saveNotificationsPush" onclick="saveNotificationsPushButton()" />
            </div>
          </div>
        </section>

        <section class="account-notifications-section">
          <Header type="serverchan" icon="fa-solid fa-code" title={t("serverchan")} />
          <div class="account-notification-section-settings" data-type="serverchan">
            <Enabled ui={ui} id="serverchanenabled" checked={serverchan.enabled} />
            <Field id="serverchansendkey" placeholder={t("serverchan_sendkey")} value={secret("serverchan", "sendkey")} />
            <Buttons ui={ui} name="Serverchan" test="testNotificationsServerchanButton()" save="saveNotificationsServerchanButton()" />
          </div>
        </section>

        <section class="account-notifications-section">
          <Header type="webhook" icon="fa-solid fa-bolt" title={t("webhook")} />
          <div class="account-notification-section-settings" data-type="webhook">
            <Enabled ui={ui} id="webhookenabled" checked={webhook.enabled} />
            <div>
              <label for="webhookrequestmethod" class="capitalize">
                {t("request_method")}:
              </label>
              <div class="form-group-inline">
                <select name="webhookrequestmethod" id="webhookrequestmethod">
                  {["GET", "POST", "PUT"].map((m) => (
                    <option value={m} selected={webhookMethod === m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <Field id="webhookurl" placeholder={t("webhook_url")} value={str(webhook.config, "url")} />
            <div class="form-group-inline">
              <textarea class="thin" name="webhookcustomheaders" id="webhookcustomheaders" placeholder={t("custom_headers")}>
                {secret("webhook", "headers")}
              </textarea>
            </div>
            <div class="form-group-inline">
              <textarea name="webhookpayload" id="webhookpayload" placeholder={t("payment_notifications_payload")}>
                {data.channels.has("webhook") ? str(webhook.config, "payload") : DEFAULT_WEBHOOK_PAYLOAD}
              </textarea>
            </div>
            <div class="form-group-inline">
              <textarea name="webhookcancelationpayload" id="webhookcancelationpayload" placeholder={t("cancelation_notification_payload")}>
                {str(webhook.config, "cancelation_payload")}
              </textarea>
            </div>
            <IgnoreSsl ui={ui} id="webhookignoressl" checked={flag(webhook.config, "ignore_ssl")} />
            <Buttons ui={ui} name="Webhook" test="testNotificationsWebhookButton()" save="saveNotificationsWebhookButton()" />
            <div class="settings-notes">
              <p>
                <i class="fa-solid fa-circle-info"></i> {t("variables_available")}: {"{{days_until}}, {{subscription_name}}, {{subscription_price}}, {{subscription_currency}}, "}
                {"{{subscription_category}}, {{subscription_date}}, {{subscription_payer}}, "}
                {"{{subscription_days_until_payment}}, {{subscription_notes}}, {{subscription_url}}"}
              </p>
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}
