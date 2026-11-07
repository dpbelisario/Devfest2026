import type {
  IndoorAskRequest,
  IndoorBuilding,
  IndoorNode,
} from "../schemas/indoor.js";
import {
  findIndoorRoute,
  indoorCatalog,
  normalizeRoomCode,
  type IndoorRoute,
} from "./indoorService.js";

type Language = IndoorAskRequest["language"];
export interface IndoorStep {
  from: string;
  to: string;
  floor: number;
  action:
    | "straight"
    | "left"
    | "right"
    | "around"
    | "up"
    | "down"
    | "align"
    | "arrive";
  headingDegrees: number | null;
  texts: Record<Language, string>;
}
export interface IndoorChoice {
  label: string;
  buildingId: string;
  checkpointId?: string;
}
export interface IndoorAskReply {
  status:
    "need-room" | "need-building" | "need-checkpoint" | "not-found" | "ready";
  reply: string;
  context: IndoorAskRequest["context"];
  choices: IndoorChoice[];
  route?: IndoorRoute & {
    steps: IndoorStep[];
    alignmentLabel: string;
    source: IndoorBuilding["source"];
  };
}

const text = (
  language: Language,
  en: string,
  ja: string,
  zh: string,
  ko: string,
) => ({ en, ja, zh, ko })[language];
const label = (node: IndoorNode, language: Language) =>
  language === "ja" ? (node.labelJa ?? node.label) : node.label;
const wrap = (angle: number) => ((angle + 540) % 360) - 180;
const heading = (a: IndoorNode, b: IndoorNode) =>
  ((Math.atan2(b.x - a.x, a.y - b.y) * 180) / Math.PI + 360) % 360;

/** Generate text and camera-overlay actions from the same graph path. */
export function indoorSteps(route: IndoorRoute): IndoorStep[] {
  const steps: IndoorStep[] = [];
  let previousHeading: number | null = null;
  for (let i = 0; i < route.edges.length; i++) {
    const from = route.nodes[i]!;
    let to = route.nodes[i + 1]!;
    const edge = route.edges[i]!;
    const isFloorChange = from.floor !== to.floor;
    const direction = isFloorChange ? null : heading(from, to);
    // Collapse collinear corridor segments into a single landmark instruction.
    if (!isFloorChange && to.kind === "corridor") {
      while (i + 1 < route.edges.length) {
        const after = route.nodes[i + 2]!;
        if (
          after.floor !== to.floor ||
          after.kind !== "corridor" ||
          Math.abs(wrap(heading(to, after) - direction!)) > 10
        )
          break;
        to = after;
        i++;
      }
    }
    let action: IndoorStep["action"];
    if (isFloorChange) action = to.floor < from.floor ? "down" : "up";
    else if (previousHeading === null) action = "align";
    else {
      const turn = wrap(direction! - previousHeading);
      action =
        Math.abs(turn) > 145
          ? "around"
          : turn > 30
            ? "right"
            : turn < -30
              ? "left"
              : "straight";
    }
    const texts = Object.fromEntries(
      (["en", "ja", "zh", "ko"] as const).map((language) => {
        const target = label(to, language);
        const final = to.id === route.nodes.at(-1)?.id;
        const lift = edge.kind === "lift";
        let message: string;
        if (isFloorChange) {
          message = text(
            language,
            `Go ${action} to ${to.floor}F using ${lift ? "the lift (operation unverified)" : "the stairs"}.`,
            `${lift ? "エレベーター（運行未確認）" : "階段"}で${to.floor}階へ${action === "down" ? "下りて" : "上がって"}ください。`,
            `通过${lift ? "电梯（运行未确认）" : "楼梯"}${action === "down" ? "下" : "上"}到${to.floor}楼。`,
            `${lift ? "엘리베이터 (운행 미확인)" : "계단"}로 ${to.floor}층으로 ${action === "down" ? "내려가세요" : "올라가세요"}.`,
          );
        } else if (action === "align") {
          message = text(
            language,
            `Face ${target}, then continue toward it.`,
            `${target}の方向を向いて進んでください。`,
            `面向${target}，然后向它前进。`,
            `${target} 쪽을 바라보고 이동하세요.`,
          );
        } else {
          const verb =
            action === "right"
              ? "Turn right"
              : action === "left"
                ? "Turn left"
                : action === "around"
                  ? "Turn around"
                  : "Continue straight";
          message = text(
            language,
            `${verb} toward ${target}.`,
            `${action === "right" ? "右へ" : action === "left" ? "左へ" : action === "around" ? "後ろへ向きを変えて" : "直進して"}${target}へ進んでください。`,
            `${action === "right" ? "右转" : action === "left" ? "左转" : action === "around" ? "转身" : "直走"}前往${target}。`,
            `${action === "right" ? "우회전해서" : action === "left" ? "좌회전해서" : action === "around" ? "돌아서" : "직진해서"} ${target}로 이동하세요.`,
          );
        }
        if (final)
          message += text(
            language,
            " Check the room door sign.",
            " 教室の入口表示を確認してください。",
            " 请核对教室门牌。",
            " 교실 문 번호를 확인하세요.",
          );
        return [language, message];
      }),
    ) as Record<Language, string>;
    steps.push({
      from: from.id,
      to: to.id,
      floor: to.floor,
      action,
      headingDegrees: direction,
      texts,
    });
    previousHeading = direction;
  }
  if (!steps.length) {
    const node = route.nodes[0]!;
    steps.push({
      from: node.id,
      to: node.id,
      floor: node.floor,
      action: "arrive",
      headingDegrees: null,
      texts: {
        en: "Check the room door sign: you selected this as your current location.",
        ja: "現在地として選んだ教室です。入口表示を確認してください。",
        zh: "这是您选择的当前位置，请核对门牌。",
        ko: "현재 위치로 선택한 교실입니다. 문 번호를 확인하세요.",
      },
    });
  }
  return steps;
}

function destinationCode(message: string): string | undefined {
  const normalized = message.normalize("NFKC");
  const direct =
    normalized.match(/\bto\s+(?:room\s+)?([a-z]?\s*-?\s*\d{2,4})\b/i) ??
    normalized.match(
      /(?:\b(?:to\s+)?(?:room|classroom)\s*|(?:教室|講義室)\s*)([a-z]?\s*-?\s*\d{2,4})\b/i,
    ) ??
    normalized.match(/\b(?:to|find)\s+([a-z]?\d{2,4})\b/i) ??
    normalized.match(/([a-z]?\d{2,4})\s*(?:教室|講義室)/i);
  if (direct?.[1]) return normalizeRoomCode(direct[1]);
  if (/^\s*[a-z]?\s*-?\s*\d{2,4}\s*$/i.test(normalized))
    return normalizeRoomCode(normalized);
  const code = normalized.match(/\b([a-z]\s*-?\s*\d{2,3})\b/i);
  return code?.[1] ? normalizeRoomCode(code[1]) : undefined;
}

function mentionsAlias(message: string, alias: string): boolean {
  const clean = (value: string) =>
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[-\s]+/g, " ")
      .trim();
  const name = clean(alias);
  const content = clean(message);
  if (!/^[a-z]/.test(name)) return content.includes(name);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(content);
}

function roomCode(node: IndoorNode): string {
  return normalizeRoomCode(node.label.replace(/^room\s+/i, ""));
}

function gpsCandidate(request: IndoorAskRequest): IndoorBuilding | undefined {
  if (
    request.location?.source !== "gps" ||
    request.location.accuracyMeters === undefined ||
    request.location.accuracyMeters > 35
  )
    return undefined;
  const { lat, lng } = request.location;
  return indoorCatalog.buildings.find((building) => {
    if (!building.location) return false;
    const dy = (lat - building.location.latitude) * 111_320;
    const dx =
      (lng - building.location.longitude) *
      111_320 *
      Math.cos((lat * Math.PI) / 180);
    return Math.hypot(dx, dy) <= 60;
  });
}

/**
 * Resolve explicit room-code questions and contextual follow-ups. The assistant
 * cannot infer an indoor floor or facing direction from GPS. All route language
 * is generated from graph connections, never ungrounded model prose.
 */
export function answerIndoorQuestion(
  request: IndoorAskRequest,
): IndoorAskReply {
  const language = request.language;
  const utterance = normalizeRoomCode(request.message);
  const explicit = indoorCatalog.buildings.find((b) =>
    [b.name, b.nameJa, ...b.aliases].some((alias) =>
      mentionsAlias(request.message, alias),
    ),
  );
  if (
    !explicit &&
    /\bengineering\s+(?:building\s+)?(?:[ivx]+|\d+)\b/i.test(request.message)
  ) {
    return {
      status: "not-found",
      reply: text(
        language,
        "I don't have an indoor map for that engineering building yet.",
        "その工学部の建物の屋内地図はまだありません。",
        "暂无该工学楼的室内地图。",
        "해당 공학 건물의 실내 지도가 아직 없습니다.",
      ),
      context: {},
      choices: [],
    };
  }
  const stored = indoorCatalog.buildings.find(
    (b) => b.id === request.context.buildingId,
  );
  const building = explicit ?? stored;
  const startOnly =
    /^(?:i[’']?m|i am|from)\b/i.test(request.message.trim()) &&
    !/\b(?:to|find|need)\b/i.test(request.message);
  const code =
    startOnly && request.context.destinationId
      ? undefined
      : destinationCode(request.message);
  const destination = building?.nodes.find(
    (n) =>
      n.kind === "room" &&
      (code ? roomCode(n) === code : n.id === request.context.destinationId),
  );
  const context: IndoorAskRequest["context"] = building
    ? {
        buildingId: building.id,
        ...(destination ? { destinationId: destination.id } : {}),
        ...(building.id === stored?.id && request.context.checkpointId
          ? { checkpointId: request.context.checkpointId }
          : {}),
      }
    : {};
  if (!building) {
    const matches = code
      ? indoorCatalog.buildings.filter((b) =>
          b.nodes.some((n) => n.kind === "room" && roomCode(n) === code),
        )
      : [];
    const near = gpsCandidate(request);
    const candidates = near
      ? [near, ...matches.filter((b) => b.id !== near.id)]
      : matches.length
        ? matches
        : indoorCatalog.buildings;
    return {
      status: "need-building",
      reply: text(
        language,
        near
          ? `Your GPS is near ${near.name}. Are you inside it?`
          : "Which building are you inside?",
        near
          ? `${near.nameJa}の近くです。この建物の中ですか？`
          : "どの建物の中にいますか？",
        "您在哪栋楼内？",
        "어느 건물 안에 있나요?",
      ),
      context: code ? { ...request.context, destinationId: code } : {},
      choices: candidates.map((b) => ({
        buildingId: b.id,
        label: language === "ja" ? b.nameJa : b.name,
      })),
    };
  }
  // A pending code survives the one-tap building confirmation.
  const target =
    destination ??
    building.nodes.find(
      (n) =>
        !code &&
        n.kind === "room" &&
        roomCode(n) === request.context.destinationId,
    );
  if (!target)
    return {
      status: code ? "not-found" : "need-room",
      reply: text(
        language,
        code
          ? `I don't have room ${code} mapped in ${building.name}. Check the room or building name.`
          : "Which room number do you need?",
        code
          ? `${building.nameJa}の${code}教室は登録されていません。教室番号・建物名を確認してください。`
          : "教室番号を教えてください。",
        code
          ? `没有该教室的地图：${code}。请核对教室或楼名。`
          : "您要找哪个教室？",
        code
          ? `${code} 교실 지도가 없습니다. 교실과 건물명을 확인하세요.`
          : "교실 번호를 알려주세요.",
      ),
      context,
      choices: [],
    };
  context.destinationId = target.id;
  let checkpoint = building.nodes.find((n) => n.id === context.checkpointId);
  // A stated starting landmark is distinct from the destination room.
  if (
    /\b(i'?m|i am|from|at|standing)\b|現在|今|いる|在|있/i.test(request.message)
  ) {
    const found = building.nodes.find(
      (n) =>
        n.kind !== "corridor" &&
        n.id !== target.id &&
        [n.label, ...n.aliases].some(
          (alias) =>
            alias.length >= 3 && utterance.includes(normalizeRoomCode(alias)),
        ),
    );
    if (found && found.id !== target.id) checkpoint = found;
  }
  if (!checkpoint) {
    const visible = building.nodes.filter(
      (n) => n.kind !== "corridor" && n.id !== target.id,
    );
    const priority = [
      "eng2-office-3",
      "eng2-231",
      "eng2-f3-north-stairs",
      "eng2-f2-north-stairs",
      "eng2-222",
      "eng2-library-1",
    ];
    visible.sort(
      (a, b) =>
        (priority.indexOf(a.id) < 0 ? 100 : priority.indexOf(a.id)) -
        (priority.indexOf(b.id) < 0 ? 100 : priority.indexOf(b.id)),
    );
    return {
      status: "need-checkpoint",
      reply: text(
        language,
        `${target.label} is on ${target.floor}F. What room or landmark can you see now?`,
        `${label(target, language)}は${target.floor}階です。今見える教室や目印を選んでください。`,
        `${target.label}在${target.floor}楼。您现在能看到哪个教室或地标？`,
        `${target.label}는 ${target.floor}층입니다. 현재 보이는 교실이나 표식을 선택하세요.`,
      ),
      context,
      choices: visible.slice(0, 6).map((n) => ({
        buildingId: building.id,
        checkpointId: n.id,
        label: label(n, language),
      })),
    };
  }
  context.checkpointId = checkpoint.id;
  const route = findIndoorRoute(
    building,
    checkpoint.id,
    target.id,
    request.avoidStairs,
  );
  if (!route)
    return {
      status: "not-found",
      reply: text(
        language,
        "There isn't a mapped indoor path from that checkpoint.",
        "その地点からの屋内経路は登録されていません。",
        "该起点尚无室内路线。",
        "해당 지점에서의 실내 경로가 없습니다.",
      ),
      context,
      choices: [],
    };
  const steps = indoorSteps(route);
  const reply =
    text(
      language,
      `From ${checkpoint.label} to ${target.label} (${target.floor}F):`,
      `${label(checkpoint, language)}から${label(target, language)}（${target.floor}階）へ：`,
      `从${checkpoint.label}到${target.label}（${target.floor}楼）：`,
      `${checkpoint.label}에서 ${target.label} (${target.floor}층)로:`,
    ) +
    "\n" +
    steps.map((step, i) => `${i + 1}. ${step.texts[language]}`).join("\n");
  return {
    status: "ready",
    reply,
    context,
    choices: [],
    route: {
      ...route,
      steps,
      alignmentLabel: label(route.nodes[1] ?? checkpoint, language),
      source: building.source,
    },
  };
}
