import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseUfdrReportXml, parseUfdrReportXmlStream } from "../src/ufdr-report-parser";

function esc(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function field(name: string, value: string) {
  return `<field name="${name}"><value>${esc(value)}</value></field>`;
}

function instantMessageModel(id: string, body: string, timestamp: string, senderId = "party-owner") {
  return [
    `<model type="InstantMessage" id="${id}">`,
    field("Identifier", id),
    field("Body", body),
    field("TimeStamp", timestamp),
    `<modelField name="From"><model type="Party" id="${senderId}">`,
    field("Identifier", senderId),
    field("Name", "Owner"),
    field("IsPhoneOwner", "true"),
    "</model></modelField>",
    "</model>"
  ].join("");
}

function chatModelWithMessages(messageCount: number) {
  const messages = Array.from({ length: messageCount }, (_, i) =>
    instantMessageModel(`msg-${i + 1}`, `texto-${i + 1}`, `2026-01-01T10:${String(i % 60).padStart(2, "0")}:00Z`)
  ).join("");
  return [
    `<model type="Chat" id="chat-1">`,
    field("Id", "chat-1"),
    field("Name", "Chat UFDR"),
    field("SourceApplication", "WhatsApp"),
    `<multiModelField name="Participants"><model type="Party" id="party-owner">`,
    field("Identifier", "party-owner"),
    field("Name", "Owner"),
    field("IsPhoneOwner", "true"),
    "</model></multiModelField>",
    `<multiModelField name="Messages">${messages}</multiModelField>`,
    "</model>"
  ].join("");
}

async function withTempXml(xml: string, fn: (filePath: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "ufdr-parser-test-"));
  const filePath = path.join(dir, "Report.xml");
  try {
    await writeFile(filePath, xml, "utf-8");
    await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("parseUfdrReportXml extrai device, user account, location e mensagem", () => {
  const xml = `
    <report>
      <device>
        <manufacturer>Samsung</manufacturer>
        <model>SM-S901E</model>
        <imei>111111111111111</imei>
        <imei2>222222222222222</imei2>
        <iccid>8955</iccid>
        <msisdn>5511999999999</msisdn>
      </device>
      <model type="UserAccount" id="acc-1">
        ${field("Identifier", "acc-1")}
        ${field("Source", "WhatsApp")}
        ${field("ServiceType", "messaging")}
        ${field("Username", "investigado")}
        <multiModelField name="Entries">
          <model type="Entry" id="entry-1">
            ${field("Category", "phone")}
            ${field("Value", "+5511999999999")}
          </model>
        </multiModelField>
      </model>
      <model type="Location" id="loc-1">
        ${field("Name", "Ponto A")}
        ${field("TimeStamp", "2026-04-11T10:00:00Z")}
        <modelField name="Position">
          <model type="Coordinate" id="coord-1">
            ${field("Latitude", "-23.55052")}
            ${field("Longitude", "-46.63331")}
            ${field("GpsHorizontalAccuracy", "12")}
          </model>
        </modelField>
      </model>
      ${chatModelWithMessages(1)}
    </report>
  `;

  const parsed = parseUfdrReportXml(xml);
  assert.equal(parsed.device?.imei2, "222222222222222");
  assert.equal(parsed.device?.iccid, "8955");
  assert.equal(parsed.device?.msisdn, "5511999999999");
  assert.equal(parsed.userAccounts.length, 1);
  assert.equal(parsed.userAccounts[0]?.entries.length, 1);
  assert.equal(parsed.locations.length, 1);
  assert.equal(parsed.locations[0]?.latitude, -23.55052);
  assert.equal(parsed.locations[0]?.longitude, -46.63331);
  assert.equal(parsed.chats.length, 1);
  assert.equal(parsed.chats[0]?.messages.length, 1);
  assert.equal(parsed.chats[0]?.messages[0]?.body, "texto-1");
});

test("parseUfdrReportXmlStream cria device mesmo quando só há IMEI2/ICCID/MSISDN", async () => {
  const xml = `
    <report>
      <model type="DeviceInfo" id="dev-1">
        ${field("IMEI2", "333333333333333")}
        ${field("ICCID", "8999")}
        ${field("MSISDN", "5511888888888")}
      </model>
    </report>
  `;

  await withTempXml(xml, async (filePath) => {
    const parsed = await parseUfdrReportXmlStream(filePath);
    assert.equal(parsed.device?.imei2, "333333333333333");
    assert.equal(parsed.device?.iccid, "8999");
    assert.equal(parsed.device?.msisdn, "5511888888888");
  });
});

test("parseUfdrReportXmlStream não limita mensagens em 500 por padrão", async () => {
  const xml = `<report>${chatModelWithMessages(650)}</report>`;
  await withTempXml(xml, async (filePath) => {
    const parsed = await parseUfdrReportXmlStream(filePath);
    assert.equal(parsed.chats.length, 1);
    assert.equal(parsed.chats[0]?.messages.length, 650);
  });
});

test("stream e parse completo mantêm paridade de chats, contas e localizações", async () => {
  const xml = `
    <report>
      <device>
        <manufacturer>Apple</manufacturer>
        <model>iPhone 14</model>
        <imei2>444444444444444</imei2>
      </device>
      <model type="UserAccount" id="acc-2">
        ${field("Identifier", "acc-2")}
        ${field("Source", "Telegram")}
      </model>
      <model type="WirelessNetwork" id="wifi-1">
        ${field("Latitude", "-22.9068")}
        ${field("Longitude", "-43.1729")}
      </model>
      ${chatModelWithMessages(2)}
    </report>
  `;

  const full = parseUfdrReportXml(xml);
  await withTempXml(xml, async (filePath) => {
    const stream = await parseUfdrReportXmlStream(filePath);
    assert.equal(stream.chats.length, full.chats.length);
    assert.equal(stream.chats[0]?.messages.length, full.chats[0]?.messages.length);
    assert.equal(stream.userAccounts.length, full.userAccounts.length);
    assert.equal(stream.locations.length, full.locations.length);
    assert.equal(stream.device?.imei2, "444444444444444");
  });
});
