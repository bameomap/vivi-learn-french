import { useState, useCallback, useEffect, useRef } from "react";

const C = {
  ink:"#1a1a2e", paper:"#faf8f4", cream:"#f0ece2",
  purple:"#6b4fbb", purpleL:"#ede8f8",
  gold:"#c9a84c", green:"#3d8b6f", red:"#c0392b",
  gray:"#8a8a9a", border:"#ddd8cc", white:"#ffffff"
};

const DEFAULTS = `la boulangerie — tiệm bánh mì
le marché — chợ
la pharmacie — nhà thuốc
la pomme — táo
la tomate — cà chua
le croissant — bánh sừng bò
un kilo de — một kg
la carte bancaire — thẻ ngân hàng
les espèces — tiền mặt
le reçu — biên lai`;

// ── Helpers ────────────────────────────────────────────────
function parseWords(text) {
  return text.split("\n").map(l => l.trim()).filter(Boolean).map(line => {
    const parts = line.split("—").map(p => p.trim());
    return { fr: parts[0] || "", vi: parts[1] || "" };
  }).filter(w => w.fr.length > 0);
}

// ── API Key (set at runtime) ────────────────────────────────
let _apiKey = "";
function setApiKey(k) { _apiKey = k; localStorage.setItem("api_key", k); }
function getApiKey() { return _apiKey || localStorage.getItem("api_key") || ""; }

async function callAI(prompt, apiKey) {
  const key = apiKey || getApiKey();
  if (!key) throw new Error("Chưa nhập API key!");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8000,
      system: "You are a JSON API. Output valid JSON only. No markdown, no backticks. Start with { end with }.",
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const raw = data.content.map(c => c.text || "").join("").trim();
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("Phản hồi không hợp lệ");
  return JSON.parse(raw.slice(s, e + 1));
}

async function callAIBatched(type, words, n) {
  if (type === "matching" || n <= 15) return callAI(buildPrompt(type, words, n));
  const h1 = Math.ceil(n / 2), h2 = n - h1;
  const [r1, r2] = await Promise.all([callAI(buildPrompt(type, words, h1)), callAI(buildPrompt(type, words, h2))]);
  if (type === "multiple_choice") return { type, questions: [...(r1.questions||[]), ...(r2.questions||[])] };
  if (type === "fill_blank") return { type, questions: [...(r1.questions||[]), ...(r2.questions||[])] };
  if (type === "mixed") {
    const merge = sType => {
      const a = r1.sections?.find(s => s.sectionType === sType);
      const b = r2.sections?.find(s => s.sectionType === sType);
      if (sType === "matching") return a || b;
      return { sectionType: sType, questions: [...(a?.questions||[]), ...(b?.questions||[])] };
    };
    return { type, sections: ["multiple_choice","fill_blank","matching"].map(merge).filter(Boolean) };
  }
  return r1;
}

function buildPrompt(type, words, n = 8) {
  n = Math.min(n, 30);
  const list = words.map(w => w.vi ? `${w.fr} — ${w.vi}` : w.fr).join("\n");
  const reuse = n > words.length ? " Reuse words in different styles to reach the count." : "";
  if (type === "multiple_choice")
    return `French teacher. Create exactly ${n} multiple choice questions mixing FR→VI and VI→FR.${reuse}\nVocabulary:\n${list}\nReturn ONLY JSON: {"type":"multiple_choice","questions":[{"question":"...","options":["A","B","C","D"],"answer":"exact option text","explanation":"Vietnamese note about correct answer","wrongExplanations":{"wrong option text":"what it means in Vietnamese"}}]}`;
  if (type === "fill_blank")
    return `French teacher. Create exactly ${n} fill-in-the-blank sentences using ___ for blank.${reuse}\nVocabulary:\n${list}\nReturn ONLY JSON: {"type":"fill_blank","questions":[{"sentence":"French sentence with ___","answer":"missing word","hint":"Vietnamese meaning"}]}`;
  if (type === "matching")
    return `French teacher. Create matching pairs.\nVocabulary:\n${list}\nReturn ONLY JSON: {"type":"matching","pairs":[{"fr":"French word","vi":"Vietnamese meaning"}]}`;
  if (type === "mixed")
    return `French teacher. Create ${Math.ceil(n/2)} multiple choice + ${Math.floor(n/2)} fill-in-blank + matching pairs.${reuse}\nVocabulary:\n${list}\nReturn ONLY JSON: {"type":"mixed","sections":[{"sectionType":"multiple_choice","questions":[{"question":"...","options":["A","B","C","D"],"answer":"exact option","explanation":"tip","wrongExplanations":{"wrong option":"meaning"}}]},{"sectionType":"fill_blank","questions":[{"sentence":"sentence with ___","answer":"word","hint":"Vietnamese"}]},{"sectionType":"matching","pairs":[{"fr":"word","vi":"meaning"}]}]}`;
  return "";
}

// ── Storage (localStorage for standalone deployment) ────────
const SETS_KEY = "vocab_sets";
async function loadSets() {
  try { const r = localStorage.getItem(SETS_KEY); return r ? JSON.parse(r) : []; } catch { return []; }
}
async function saveSets(sets) {
  try { localStorage.setItem(SETS_KEY, JSON.stringify(sets)); } catch {}
}

// ── Text-to-Speech ─────────────────────────────────────────
function speak(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "fr-FR"; u.rate = 0.85;
  const voices = window.speechSynthesis.getVoices();
  const fr = voices.find(v => v.lang.startsWith("fr"));
  if (fr) u.voice = fr;
  window.speechSynthesis.speak(u);
}

function SpeakBtn({ text, size = "0.8rem" }) {
  const [playing, setPlaying] = useState(false);
  const go = (e) => {
    e.stopPropagation();
    setPlaying(true);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-FR"; u.rate = 0.85;
    const voices = window.speechSynthesis.getVoices();
    const fr = voices.find(v => v.lang.startsWith("fr"));
    if (fr) u.voice = fr;
    u.onend = () => setPlaying(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  };
  return (
    <button onClick={go} title="Nghe phát âm"
      style={{ background:"none", border:"none", cursor:"pointer", fontSize:size, padding:"0 0.2rem", opacity: playing ? 1 : 0.6, transition:"opacity 0.2s" }}>
      {playing ? "🔊" : "🔈"}
    </button>
  );
}

// ── Conversation Panel ──────────────────────────────────────
const EDITO_SCENARIOS = [
  { id:"greet",    label:"Saluer", icon:"👋", desc:"Chào hỏi & giới thiệu bản thân", prompt:"You are a friendly French person at a café. The learner is A1 level. Start with a simple greeting. Keep sentences very short and simple. After each learner reply, give a short correction note in Vietnamese if needed (prefix with 💡), then continue the conversation naturally." },
  { id:"shop",     label:"Faire les courses", icon:"🛒", desc:"Mua sắm tại chợ / siêu thị", prompt:"You are a French market vendor. The learner is A1 level. Start by greeting and asking what they need. Keep sentences very short. After each learner reply, give a short correction note in Vietnamese if needed (prefix with 💡), then respond as the vendor." },
  { id:"cafe",     label:"Au café", icon:"☕", desc:"Gọi đồ tại quán cà phê", prompt:"You are a French waiter at a café. The learner is A1 level. Start by welcoming them. Keep sentences short. After each learner reply, give a short correction note in Vietnamese if needed (prefix with 💡), then respond as the waiter." },
  { id:"school",   label:"À l'école", icon:"🏫", desc:"Nói chuyện tại trường học", prompt:"You are a French classmate. The learner is A1 level. Start by introducing yourself and asking their name. Keep it simple. After each learner reply, give a short correction note in Vietnamese if needed (prefix with 💡), then continue chatting." },
  { id:"direction",label:"Demander le chemin", icon:"🗺️", desc:"Hỏi đường trong thành phố", prompt:"You are a French passerby in the street. The learner is A1 level. Wait for them to ask for directions. Give simple directions. After each reply, give a short correction note in Vietnamese if needed (prefix with 💡)." },
  { id:"family",   label:"La famille", icon:"👨‍👩‍👧", desc:"Nói về gia đình", prompt:"You are a friendly French neighbor. The learner is A1 level. Start by asking about their family. Keep questions short. After each learner reply, give a short correction note in Vietnamese if needed (prefix with 💡), then continue." },
];

async function callAIText(messages, systemPrompt) {
  const key = getApiKey();
  if (!key) throw new Error("Chưa nhập API key!");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 300, system: systemPrompt, messages })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content.map(c => c.text || "").join("").trim();
}

function ConversationPanel() {
  const [scenario, setScenario] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const bottomRef = useRef(null);

  const startScenario = async (sc) => {
    setScenario(sc); setMessages([]); setInput(""); setErr(""); setLoading(true);
    try {
      const reply = await callAIText([], sc.prompt + " Begin now.");
      setMessages([{ role:"assistant", text: reply }]);
    } catch(e) { setErr(e.message); }
    setLoading(false);
  };

  const send = async () => {
    if (!input.trim() || loading) return;
    const userMsg = { role:"user", text: input.trim() };
    const newMsgs = [...messages, userMsg];
    setMessages(newMsgs); setInput(""); setLoading(true);
    try {
      const apiMsgs = newMsgs.map(m => ({ role: m.role, content: m.text }));
      const reply = await callAIText(apiMsgs, scenario.prompt);
      setMessages(m => [...m, { role:"assistant", text: reply }]);
    } catch(e) { setErr(e.message); }
    setLoading(false);
  };

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:"smooth" }); }, [messages]);

  if (!scenario) return (
    <div style={{ padding:"1rem" }}>
      <div style={{ fontSize:"0.72rem", fontWeight:600, color:"#2980b9", marginBottom:"0.2rem" }}>💬 Hội thoại thực hành</div>
      <div style={{ fontSize:"0.73rem", color:C.gray, marginBottom:"1rem", lineHeight:1.6 }}>Chọn tình huống để bắt đầu luyện nói. AI sẽ đóng vai và sửa lỗi nhẹ nhàng bằng tiếng Việt.</div>
      <div style={{ display:"flex", flexDirection:"column", gap:"0.6rem" }}>
        {EDITO_SCENARIOS.map(sc => (
          <button key={sc.id} onClick={() => startScenario(sc)}
            style={{ background:C.white, border:`1.5px solid #2980b944`, borderRadius:12, padding:"0.9rem 1rem", textAlign:"left", cursor:"pointer", fontFamily:"inherit", transition:"all 0.15s" }}
            onMouseEnter={e=>e.currentTarget.style.background="#e8f4fd"}
            onMouseLeave={e=>e.currentTarget.style.background=C.white}>
            <div style={{ display:"flex", alignItems:"center", gap:"0.6rem" }}>
              <span style={{ fontSize:"1.4rem" }}>{sc.icon}</span>
              <div>
                <div style={{ fontFamily:"Georgia,serif", fontSize:"0.95rem", color:C.ink, marginBottom:"0.15rem" }}>{sc.label}</div>
                <div style={{ fontSize:"0.72rem", color:C.gray }}>{sc.desc}</div>
              </div>
              <span style={{ marginLeft:"auto", color:"#2980b9", fontSize:"0.8rem" }}>→</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"calc(100vh - 56px)" }}>
      {/* Chat header */}
      <div style={{ background:"#2980b9", color:C.white, padding:"0.7rem 1rem", display:"flex", alignItems:"center", gap:"0.6rem" }}>
        <button onClick={()=>setScenario(null)} style={{ background:"none", border:"none", color:C.white, cursor:"pointer", fontSize:"0.85rem" }}>←</button>
        <span style={{ fontSize:"1.1rem" }}>{scenario.icon}</span>
        <div>
          <div style={{ fontFamily:"Georgia,serif", fontSize:"0.92rem" }}>{scenario.label}</div>
          <div style={{ fontSize:"0.65rem", opacity:0.8 }}>{scenario.desc}</div>
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex:1, overflowY:"auto", padding:"1rem", display:"flex", flexDirection:"column", gap:"0.65rem", background:C.cream }}>
        {messages.map((m, i) => {
          const isUser = m.role === "user";
          // Split correction from main text
          const parts = m.text.split(/(💡[^\n]+)/g);
          return (
            <div key={i} style={{ display:"flex", flexDirection:"column", alignItems: isUser ? "flex-end" : "flex-start" }}>
              {parts.map((p, j) => p.startsWith("💡") ? (
                <div key={j} style={{ fontSize:"0.72rem", color:C.gold, background:"#fff8e6", border:`1px solid ${C.gold}44`, borderRadius:8, padding:"0.3rem 0.65rem", marginTop:"0.25rem", maxWidth:"88%" }}>{p}</div>
              ) : p.trim() ? (
                <div key={j} style={{ background: isUser ? "#2980b9" : C.white, color: isUser ? C.white : C.ink, borderRadius: isUser ? "16px 16px 4px 16px" : "16px 16px 16px 4px", padding:"0.6rem 0.9rem", maxWidth:"85%", fontSize:"0.88rem", lineHeight:1.6, boxShadow:"0 1px 3px rgba(0,0,0,0.08)" }}>
                    {p.trim()}
                    {!isUser && <SpeakBtn text={p.trim()} size="0.75rem" />}
                  </div>
              ) : null)}
            </div>
          );
        })}
        {loading && (
          <div style={{ display:"flex", alignItems:"center", gap:"0.4rem", color:C.gray, fontSize:"0.78rem" }}>
            <div style={{ width:14, height:14, border:`2px solid ${C.border}`, borderTopColor:"#2980b9", borderRadius:"50%", animation:"spin 0.8s linear infinite" }}/> Đang trả lời...
          </div>
        )}
        {err && <div style={{ color:C.red, fontSize:"0.75rem" }}>⚠ {err}</div>}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ padding:"0.75rem 1rem", background:C.white, borderTop:`1px solid ${C.border}`, display:"flex", gap:"0.5rem" }}>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&send()}
          placeholder="Nhập câu trả lời bằng tiếng Pháp..."
          style={{ flex:1, border:`1.5px solid ${C.border}`, borderRadius:20, padding:"0.5rem 0.85rem", fontSize:"0.85rem", fontFamily:"inherit", outline:"none", color:C.ink }} />
        <button onClick={send} disabled={loading||!input.trim()}
          style={{ padding:"0.5rem 1rem", background: input.trim() ? "#2980b9" : C.border, color:C.white, border:"none", borderRadius:20, fontSize:"0.82rem", cursor: input.trim() ? "pointer" : "default", fontFamily:"Georgia,serif" }}>
          Gửi
        </button>
      </div>
    </div>
  );
}

// ── Writing Panel ───────────────────────────────────────────
function WritingPanel() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem("writing_history") || "[]"); } catch { return []; }
  });

  const check = async () => {
    if (!input.trim()) return;
    setLoading(true); setErr(""); setResult(null);
    try {
      const r = await callAI(`You are a French teacher for A1 students. Evaluate this French sentence written by a Vietnamese learner.
Sentence: "${input.trim()}"

Return ONLY JSON:
{
  "score": 0-100,
  "verdict": "Xuất sắc|Tốt|Khá|Cần cải thiện",
  "corrected": "corrected sentence or same if perfect",
  "is_perfect": true/false,
  "errors": [{"original":"wrong part","correction":"correct part","type":"Ngữ pháp|Từ vựng|Chính tả|Giới từ|Mạo từ","explanation":"explanation in Vietnamese"}],
  "tip": "one encouraging tip in Vietnamese",
  "translation": "Vietnamese translation of the corrected sentence"
}`);
      const entry = { sentence: input.trim(), result: r, date: new Date().toLocaleDateString("vi-VN") };
      const newHistory = [entry, ...history].slice(0, 30);
      setHistory(newHistory);
      localStorage.setItem("writing_history", JSON.stringify(newHistory));
      setResult(r);
      // Log error types for WeakSpots
      r.errors?.forEach(e => { if(e.type) logError(e.type); });
    } catch(e) { setErr(e.message); }
    setLoading(false);
  };

  const scoreColor = s => s >= 90 ? C.green : s >= 70 ? C.gold : s >= 50 ? "#e67e22" : C.red;
  const verdictBg = v => ({"Xuất sắc":"#e8f7f1","Tốt":"#eaf4fb","Khá":"#fff8e6","Cần cải thiện":"#fde8e6"}[v] || C.cream);

  return (
    <div style={{ padding:"1rem", display:"flex", flexDirection:"column", gap:"0.8rem" }}>
      <div style={{ fontSize:"0.72rem", fontWeight:600, color:"#e67e22", marginBottom:"-0.2rem" }}>✍️ Viết câu tự do</div>
      <div style={{ fontSize:"0.73rem", color:C.gray, lineHeight:1.6 }}>Nhập một câu tiếng Pháp bất kỳ — AI sẽ chấm điểm, chỉ ra lỗi và giải thích bằng tiếng Việt.</div>

      <div style={{ background:C.white, border:`1.5px solid ${C.border}`, borderRadius:12, padding:"0.85rem" }}>
        <textarea value={input} onChange={e=>setInput(e.target.value)}
          placeholder="Nhập câu tiếng Pháp... vd: Je suis une étudiant."
          style={{ width:"100%", minHeight:80, border:`1.5px solid ${C.border}`, borderRadius:8, padding:"0.55rem 0.7rem", fontFamily:"Georgia,serif", fontSize:"0.92rem", lineHeight:1.6, outline:"none", resize:"vertical", boxSizing:"border-box", color:C.ink }} />
        {err && <div style={{ fontSize:"0.72rem", color:C.red, marginTop:"0.4rem" }}>⚠ {err}</div>}
        <button onClick={check} disabled={loading||!input.trim()}
          style={{ marginTop:"0.6rem", width:"100%", padding:"0.65rem", background: input.trim() ? "#e67e22" : C.border, color:C.white, border:"none", borderRadius:8, fontFamily:"Georgia,serif", fontSize:"0.88rem", cursor: input.trim() ? "pointer" : "default" }}>
          {loading ? "AI đang chấm..." : "Chấm bài ✦"}
        </button>
      </div>

      {loading && <div style={{ display:"flex", justifyContent:"center", padding:"1rem" }}><Spinner /></div>}

      {result && (
        <div style={{ display:"flex", flexDirection:"column", gap:"0.65rem", animation:"fadeUp 0.3s ease" }}>
          {/* Score card */}
          <div style={{ background: verdictBg(result.verdict), border:`1.5px solid ${scoreColor(result.score)}44`, borderRadius:12, padding:"1rem", display:"flex", alignItems:"center", gap:"1rem" }}>
            <div style={{ textAlign:"center", minWidth:64 }}>
              <div style={{ fontFamily:"Georgia,serif", fontSize:"2.2rem", color: scoreColor(result.score), fontWeight:700, lineHeight:1 }}>{result.score}</div>
              <div style={{ fontSize:"0.6rem", color:C.gray, textTransform:"uppercase", letterSpacing:1 }}>điểm</div>
            </div>
            <div>
              <div style={{ fontFamily:"Georgia,serif", fontSize:"1rem", color: scoreColor(result.score), marginBottom:"0.2rem" }}>{result.verdict}</div>
              {result.tip && <div style={{ fontSize:"0.75rem", color:C.gray, lineHeight:1.5 }}>{result.tip}</div>}
            </div>
          </div>

          {/* Corrected sentence */}
          {!result.is_perfect && (
            <div style={{ background:C.white, border:`1.5px solid ${C.green}44`, borderRadius:12, padding:"0.85rem" }}>
              <div style={{ fontSize:"0.63rem", textTransform:"uppercase", letterSpacing:1, color:C.green, marginBottom:"0.4rem", fontWeight:600 }}>✓ Câu đúng</div>
              <div style={{ fontFamily:"Georgia,serif", fontSize:"0.95rem", color:C.ink, marginBottom:"0.25rem" }}>{result.corrected} <SpeakBtn text={result.corrected} /></div>
              {result.translation && <div style={{ fontSize:"0.75rem", color:C.gray, fontStyle:"italic" }}>→ {result.translation}</div>}
            </div>
          )}
          {result.is_perfect && (
            <div style={{ background:"#e8f7f1", border:`1.5px solid ${C.green}`, borderRadius:12, padding:"0.85rem", textAlign:"center" }}>
              <div style={{ fontSize:"1.2rem", marginBottom:"0.3rem" }}>🎉</div>
              <div style={{ fontFamily:"Georgia,serif", color:C.green }}>Hoàn hảo! Không có lỗi nào.</div>
            </div>
          )}

          {/* Errors */}
          {result.errors?.length > 0 && (
            <div style={{ background:C.white, border:`1.5px solid ${C.border}`, borderRadius:12, padding:"0.85rem" }}>
              <div style={{ fontSize:"0.63rem", textTransform:"uppercase", letterSpacing:1, color:C.red, marginBottom:"0.6rem", fontWeight:600 }}>✗ Lỗi cần sửa ({result.errors.length})</div>
              {result.errors.map((e, i) => (
                <div key={i} style={{ borderLeft:`3px solid ${C.red}`, paddingLeft:"0.75rem", marginBottom:"0.7rem" }}>
                  <div style={{ display:"flex", gap:"0.5rem", alignItems:"center", marginBottom:"0.25rem", flexWrap:"wrap" }}>
                    <span style={{ fontFamily:"Georgia,serif", fontSize:"0.88rem", color:C.red, textDecoration:"line-through" }}>{e.original}</span>
                    <span style={{ color:C.gray }}>→</span>
                    <span style={{ fontFamily:"Georgia,serif", fontSize:"0.88rem", color:C.green, fontWeight:600 }}>{e.correction}</span>
                    <span style={{ background:`${C.purple}22`, color:C.purple, fontSize:"0.6rem", padding:"0.1rem 0.45rem", borderRadius:20 }}>{e.type}</span>
                  </div>
                  <div style={{ fontSize:"0.75rem", color:C.gray, lineHeight:1.5 }}>💡 {e.explanation}</div>
                </div>
              ))}
            </div>
          )}

          <button onClick={()=>{ setInput(""); setResult(null); }}
            style={{ padding:"0.5rem", background:"transparent", border:`1px solid ${C.border}`, borderRadius:8, color:C.gray, fontSize:"0.78rem", cursor:"pointer" }}>
            ✏️ Viết câu khác
          </button>
        </div>
      )}

      {/* History */}
      {history.length > 0 && !result && (
        <div>
          <div style={{ fontSize:"0.65rem", textTransform:"uppercase", letterSpacing:1, color:C.gray, marginBottom:"0.5rem", fontWeight:600 }}>📜 Câu đã viết gần đây</div>
          {history.slice(0,5).map((h,i) => (
            <div key={i} onClick={()=>{ setInput(h.sentence); setResult(h.result); }}
              style={{ background:C.white, border:`1px solid ${C.border}`, borderRadius:8, padding:"0.55rem 0.75rem", marginBottom:"0.35rem", cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center" }}
              onMouseEnter={e=>e.currentTarget.style.background=C.cream}
              onMouseLeave={e=>e.currentTarget.style.background=C.white}>
              <div>
                <div style={{ fontFamily:"Georgia,serif", fontSize:"0.83rem", color:C.ink }}>{h.sentence}</div>
                <div style={{ fontSize:"0.65rem", color:C.gray, marginTop:"0.1rem" }}>{h.date}</div>
              </div>
              <div style={{ fontFamily:"Georgia,serif", fontSize:"1rem", color: scoreColor(h.result.score), fontWeight:700, minWidth:36, textAlign:"center" }}>{h.result.score}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Weak Spots Panel ────────────────────────────────────────
const WEAK_KEY = "weak_spots_log";

function logError(type) {
  try {
    const log = JSON.parse(localStorage.getItem(WEAK_KEY) || "{}");
    log[type] = (log[type] || 0) + 1;
    localStorage.setItem(WEAK_KEY, JSON.stringify(log));
  } catch {}
}

function WeakSpotsPanel() {
  const [log, setLog] = useState(() => {
    try { return JSON.parse(localStorage.getItem(WEAK_KEY) || "{}"); } catch { return {}; }
  });
  const [exercises, setExercises] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [manualTopics, setManualTopics] = useState([]);

  const entries = Object.entries(log).sort((a,b) => b[1]-a[1]);
  const total = entries.reduce((s,[,v])=>s+v, 0);
  const topWeak = entries.slice(0,5).map(([k])=>k);

  const COMMON_ERRORS = ["Mạo từ le/la/l'/les","Giới từ à/de","Thì hiện tại (présent)","Phủ định ne...pas","Tính từ sở hữu","Đại từ nhân xưng","Động từ être & avoir","Số từ","Câu hỏi","Tính từ vị trí"];

  const generate = async (topics) => {
    if (!topics.length) { setErr("Chọn ít nhất 1 chủ đề!"); return; }
    setLoading(true); setErr(""); setExercises(null);
    try {
      const r = await callAI(`French teacher for A1 Vietnamese learners. Create 6 targeted exercises for these weak grammar areas: ${topics.join(", ")}.
Mix exercise types. Return ONLY JSON:
{
  "sections": [
    {
      "topic": "topic name",
      "type": "mc|fill|order",
      "exercises": [
        {"question":"...","options":["A","B","C","D"],"answer":"exact option","explanation":"Vietnamese tip"},
        {"sentence":"sentence with ___","answer":"word","hint":"Vietnamese hint","explanation":"Vietnamese why"}
      ]
    }
  ]
}`);
      setExercises(r);
    } catch(e) { setErr(e.message); }
    setLoading(false);
  };

  const toggleManual = (t) => setManualTopics(prev => prev.includes(t) ? prev.filter(x=>x!==t) : [...prev, t]);

  return (
    <div style={{ padding:"1rem", display:"flex", flexDirection:"column", gap:"0.85rem" }}>
      <div style={{ fontSize:"0.72rem", fontWeight:600, color:C.red }}>🎯 Bài tập theo điểm yếu</div>
      <div style={{ fontSize:"0.73rem", color:C.gray, lineHeight:1.6 }}>AI phân tích lỗi bạn hay gặp và tạo bài tập trúng đích.</div>

      {/* Stats from writing history */}
      {total > 0 && (
        <div style={{ background:C.white, border:`1.5px solid ${C.border}`, borderRadius:12, padding:"0.85rem" }}>
          <div style={{ fontSize:"0.63rem", textTransform:"uppercase", letterSpacing:1, color:C.red, marginBottom:"0.6rem", fontWeight:600 }}>📊 Lỗi hay gặp ({total} lần)</div>
          {entries.slice(0,6).map(([type, count], i) => (
            <div key={i} style={{ display:"flex", alignItems:"center", gap:"0.5rem", marginBottom:"0.35rem" }}>
              <div style={{ fontSize:"0.78rem", color:C.ink, flex:1 }}>{type}</div>
              <div style={{ flex:2, height:6, background:C.cream, borderRadius:3 }}>
                <div style={{ height:"100%", width:`${Math.min(100,(count/entries[0][1])*100)}%`, background:C.red, borderRadius:3 }} />
              </div>
              <div style={{ fontSize:"0.7rem", color:C.red, fontWeight:600, minWidth:20 }}>{count}</div>
            </div>
          ))}
          <button onClick={()=>generate(topWeak)} disabled={loading}
            style={{ marginTop:"0.7rem", width:"100%", padding:"0.6rem", background:C.red, color:C.white, border:"none", borderRadius:8, fontFamily:"Georgia,serif", fontSize:"0.85rem", cursor:"pointer" }}>
            🎯 Tạo bài tập theo lỗi của tôi
          </button>
        </div>
      )}

      {/* Manual topic selection */}
      <div style={{ background:C.white, border:`1.5px solid ${C.border}`, borderRadius:12, padding:"0.85rem" }}>
        <div style={{ fontSize:"0.63rem", textTransform:"uppercase", letterSpacing:1, color:C.purple, marginBottom:"0.6rem", fontWeight:600 }}>🧩 Chọn chủ đề muốn luyện</div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:"0.35rem", marginBottom:"0.7rem" }}>
          {COMMON_ERRORS.map((t,i) => (
            <button key={i} onClick={()=>toggleManual(t)}
              style={{ padding:"0.25rem 0.6rem", border:`1.5px solid ${manualTopics.includes(t)?C.purple:C.border}`, borderRadius:20, background: manualTopics.includes(t)?C.purple:C.white, color: manualTopics.includes(t)?C.white:C.ink, fontSize:"0.72rem", cursor:"pointer", fontFamily:"inherit" }}>
              {t}
            </button>
          ))}
        </div>
        {err && <div style={{ fontSize:"0.72rem", color:C.red, marginBottom:"0.5rem" }}>⚠ {err}</div>}
        <button onClick={()=>generate(manualTopics)} disabled={loading||!manualTopics.length}
          style={{ width:"100%", padding:"0.6rem", background: manualTopics.length ? C.purple : C.border, color:C.white, border:"none", borderRadius:8, fontFamily:"Georgia,serif", fontSize:"0.85rem", cursor: manualTopics.length?"pointer":"default" }}>
          {loading ? "Đang tạo bài tập..." : `Tạo bài tập (${manualTopics.length} chủ đề) ✦`}
        </button>
      </div>

      {loading && <div style={{ display:"flex", justifyContent:"center", padding:"1rem" }}><Spinner /></div>}

      {/* Exercises */}
      {exercises?.sections?.map((sec, si) => (
        <div key={si} style={{ background:C.white, border:`1.5px solid ${C.border}`, borderRadius:12, overflow:"hidden" }}>
          <div style={{ background:C.purple, color:C.white, padding:"0.6rem 0.9rem", fontSize:"0.78rem", fontFamily:"Georgia,serif" }}>
            🎯 {sec.topic}
          </div>
          <div style={{ padding:"0.85rem" }}>
            {sec.exercises?.map((ex, ei) => {
              if (ex.options) return <ExerciseMC key={ei} ex={ex} idx={ei} />;
              if (ex.sentence) return <ExerciseFill key={ei} ex={ex} idx={ei} />;
              return null;
            })}
          </div>
        </div>
      ))}

      {exercises && (
        <button onClick={()=>{ setExercises(null); setManualTopics([]); }}
          style={{ padding:"0.5rem", background:"transparent", border:`1px solid ${C.border}`, borderRadius:8, color:C.gray, fontSize:"0.78rem", cursor:"pointer" }}>
          🔄 Tạo bài khác
        </button>
      )}
    </div>
  );
}

function ExerciseMC({ ex, idx }) {
  const [ans, setAns] = useState(null);
  const norm = s => (s||"").trim().toLowerCase().replace(/[''`]/g,"'");
  const ok = ans && norm(ans) === norm(ex.answer);
  return (
    <div style={{ marginBottom:"0.7rem" }}>
      <div style={{ fontSize:"0.88rem", fontFamily:"Georgia,serif", marginBottom:"0.45rem", lineHeight:1.5 }}>
        <span style={{ fontSize:"0.63rem", color:C.gray, textTransform:"uppercase", marginRight:"0.4rem" }}>Câu {idx+1}</span>{ex.question}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0.28rem" }}>
        {ex.options?.map((opt,j) => {
          let bg=C.white,bc=C.border,col=C.ink;
          if(ans){if(norm(opt)===norm(ex.answer)){bg="#e8f7f1";bc=C.green;col=C.green;}else if(norm(opt)===norm(ans)){bg="#fde8e6";bc=C.red;col=C.red;}}
          return <button key={j} disabled={!!ans} onClick={()=>setAns(opt)}
            style={{padding:"0.38rem 0.5rem",border:`1.5px solid ${bc}`,borderRadius:8,background:bg,color:col,fontSize:"0.77rem",cursor:ans?"default":"pointer",textAlign:"left",fontFamily:"inherit"}}>{opt}</button>;
        })}
      </div>
      {ans && <div style={{ marginTop:"0.35rem", fontSize:"0.73rem", color: ok?C.green:C.gray, lineHeight:1.5 }}>
        {!ok && <div style={{ color:C.red, marginBottom:"0.1rem" }}>✗ Đáp án: <b>{ex.answer}</b></div>}
        {ok && <div style={{ color:C.green, marginBottom:"0.1rem" }}>✓ Chính xác!</div>}
        {ex.explanation && <div>💡 {ex.explanation}</div>}
      </div>}
    </div>
  );
}

function ExerciseFill({ ex, idx }) {
  const [val, setVal] = useState("");
  const [done, setDone] = useState(false);
  const ok = done && val.trim().toLowerCase() === (ex.answer||"").toLowerCase();
  return (
    <div style={{ marginBottom:"0.7rem" }}>
      <div style={{ fontSize:"0.88rem", fontFamily:"Georgia,serif", marginBottom:"0.45rem", lineHeight:1.5 }}>
        <span style={{ fontSize:"0.63rem", color:C.gray, textTransform:"uppercase", marginRight:"0.4rem" }}>Câu {idx+1}</span>
        {ex.sentence}
        {ex.hint && <span style={{ fontSize:"0.72rem", color:C.gold, marginLeft:"0.4rem" }}>({ex.hint})</span>}
      </div>
      <div style={{ display:"flex", gap:"0.38rem", alignItems:"center" }}>
        <input value={val} disabled={done} onChange={e=>setVal(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!done&&setDone(true)}
          placeholder="Điền vào..."
          style={{ border:`1.5px solid ${done?(ok?C.green:C.red):C.border}`,borderRadius:6,padding:"0.3rem 0.55rem",fontSize:"0.83rem",width:160,fontFamily:"inherit",background:done?(ok?"#e8f7f1":"#fde8e6"):C.white,color:done?(ok?C.green:C.red):C.ink,outline:"none"}}/>
        {!done && <button onClick={()=>setDone(true)} style={{padding:"0.3rem 0.65rem",background:C.ink,color:C.white,border:"none",borderRadius:6,fontSize:"0.73rem",cursor:"pointer"}}>Kiểm tra</button>}
        {done && <span style={{fontSize:"0.73rem",color:ok?C.green:C.red,fontWeight:500}}>{ok?"✓ Đúng!":`✗ Đáp án: ${ex.answer}`}</span>}
      </div>
      {done && ex.explanation && <div style={{ marginTop:"0.3rem", fontSize:"0.73rem", color:C.gray }}>💡 {ex.explanation}</div>}
    </div>
  );
}

// ── Small UI ───────────────────────────────────────────────
function SecLabel({ icon, text }) {
  return <div style={{ fontFamily:"Georgia,serif", fontSize:"0.9rem", color:C.purple, marginBottom:"0.5rem", paddingBottom:"0.28rem", borderBottom:`1px solid ${C.border}` }}>{icon} {text}</div>;
}
function Spinner() {
  return <div style={{ width:26, height:26, border:`3px solid ${C.border}`, borderTopColor:C.purple, borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />;
}
function QCard({ children, ok, wrong }) {
  return <div style={{ background: ok?"#f0faf6": wrong?"#fdf5f4":C.white, border:`1.5px solid ${ok?C.green:wrong?C.red:C.border}`, borderRadius:12, padding:"0.85rem 1rem", marginBottom:"0.6rem", transition:"all 0.2s" }}>{children}</div>;
}

// ── MC ─────────────────────────────────────────────────────
function MCSection({ questions, sl, onRecord, onWrong }) {
  const [ans, setAns] = useState({});
  const normalize = s => (s||"").trim().toLowerCase().replace(/[''`]/g,"'").replace(/\s+/g," ");
  const choose = (i, opt, correct, q) => {
    if (ans[i]) return;
    setAns(x => ({ ...x, [i]: opt }));
    const isOk = normalize(opt) === normalize(correct);
    onRecord?.(correct, isOk);
    if (!isOk) onWrong?.(q);
  };
  return (
    <div style={{ marginBottom:"0.5rem" }}>
      {sl && <SecLabel icon="☑" text="Trắc nghiệm" />}
      {questions.map((q, i) => {
        const a = ans[i];
        const norm = s => (s||"").trim().toLowerCase().replace(/[''`]/g,"'").replace(/\s+/g," ");
        const ok = a && norm(a) === norm(q.answer);
        return (
          <QCard key={i} ok={ok} wrong={a && !ok}>
            <div style={{ fontSize:"0.63rem", color:C.gray, textTransform:"uppercase", letterSpacing:1, marginBottom:4 }}>Câu {i+1}</div>
            <div style={{ fontFamily:"Georgia,serif", fontSize:"0.93rem", marginBottom:"0.6rem", lineHeight:1.5 }}>{q.question}</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0.3rem" }}>
              {q.options.map((opt, j) => {
                let bg = C.white, bc = C.border, col = C.ink;
                if (a) { if (norm(opt)===norm(q.answer)){bg="#e8f7f1";bc=C.green;col=C.green;} else if(norm(opt)===norm(a)){bg="#fde8e6";bc=C.red;col=C.red;} }
                return <button key={j} disabled={!!a} onClick={() => choose(i, opt, q.answer, q)}
                  style={{ padding:"0.42rem 0.55rem", border:`1.5px solid ${bc}`, borderRadius:8, background:bg, color:col, fontSize:"0.78rem", cursor:a?"default":"pointer", textAlign:"left", fontFamily:"inherit" }}>{opt}</button>;
              })}
            </div>
            {a && <div style={{ marginTop:"0.4rem", fontSize:"0.72rem", lineHeight:1.7 }}>
              {ok
                ? <span style={{ color:C.green }}>✓ Chính xác!{q.explanation ? ` — ${q.explanation}` : ""}</span>
                : <><div style={{ color:C.red }}>✗ <b>{a}</b>{q.wrongExplanations?.[a] ? ` — ${q.wrongExplanations[a]}` : ""}</div>
                   <div style={{ color:C.green }}>✓ <b>{q.answer}</b>{q.explanation ? ` — ${q.explanation}` : ""}</div></>
              }
            </div>}
          </QCard>
        );
      })}
    </div>
  );
}

// ── Fill ───────────────────────────────────────────────────
function FillSection({ questions, sl, onRecord, onWrong }) {
  const [inp, setInp] = useState({});
  const [chk, setChk] = useState({});
  const doCheck = (i, q, v) => {
    if (chk[i]) return;
    const ok = v.trim().toLowerCase() === (q.answer||"").toLowerCase();
    setChk(x => ({ ...x, [i]: true }));
    onRecord?.(q.answer, ok);
    if (!ok) onWrong?.(q);
  };
  return (
    <div style={{ marginBottom:"0.5rem" }}>
      {sl && <SecLabel icon="✏️" text="Điền từ" />}
      {questions.map((q, i) => {
        const v = inp[i]||"", done = chk[i];
        const ok = done && v.trim().toLowerCase()===(q.answer||"").toLowerCase();
        return (
          <QCard key={i} ok={done&&ok} wrong={done&&!ok}>
            <div style={{ fontSize:"0.63rem", color:C.gray, textTransform:"uppercase", letterSpacing:1, marginBottom:4 }}>
              Câu {i+1}{q.hint ? <span style={{ color:C.gold, marginLeft:6, textTransform:"none" }}>· gợi ý: {q.hint}</span> : null}
            </div>
            <div style={{ fontFamily:"Georgia,serif", fontSize:"0.9rem", marginBottom:"0.55rem", lineHeight:1.6 }}>{q.sentence}</div>
            <div style={{ display:"flex", gap:"0.38rem", alignItems:"center", flexWrap:"wrap" }}>
              <input value={v} disabled={done} onChange={e => setInp(x=>({...x,[i]:e.target.value}))}
                onKeyDown={e => e.key==="Enter" && doCheck(i,q,v)}
                placeholder="Nhập từ..."
                style={{ border:`1.5px solid ${done?(ok?C.green:C.red):C.border}`, borderRadius:6, padding:"0.3rem 0.55rem", fontSize:"0.83rem", width:160, fontFamily:"inherit", background:done?(ok?"#e8f7f1":"#fde8e6"):C.white, color:done?(ok?C.green:C.red):C.ink, outline:"none" }} />
              {!done && <button onClick={() => doCheck(i,q,v)} style={{ padding:"0.3rem 0.65rem", background:C.ink, color:C.white, border:"none", borderRadius:6, fontSize:"0.73rem", cursor:"pointer", fontFamily:"inherit" }}>Kiểm tra</button>}
              {done && <span style={{ fontSize:"0.73rem", color:ok?C.green:C.red, fontWeight:500 }}>{ok?"✓ Đúng!":`✗ Đáp án: ${q.answer}`}</span>}
            </div>
          </QCard>
        );
      })}
    </div>
  );
}

// ── Match ──────────────────────────────────────────────────
function MatchSection({ pairs, sl }) {
  const [shuffled] = useState(() => [...pairs].sort(() => Math.random()-0.5));
  const [selFr, setSelFr] = useState(null);
  const [matched, setMatched] = useState({});
  const [wrongKey, setWrongKey] = useState(null);
  const done = Object.keys(matched).length;
  const clickFr = fr => { if (matched[fr]) return; setSelFr(fr===selFr?null:fr); };
  const clickVi = p => {
    if (!selFr || matched[selFr]) return;
    if (p.fr===selFr) { setMatched(m=>({...m,[selFr]:true})); setSelFr(null); }
    else { setWrongKey(selFr+"|"+p.fr); setTimeout(()=>setWrongKey(null),500); setSelFr(null); }
  };
  return (
    <div style={{ marginBottom:"0.5rem" }}>
      {sl && <SecLabel icon="🔗" text="Nối từ" />}
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"0.42rem" }}>
        <span style={{ fontSize:"0.68rem", color:C.gray }}>Chọn từ Pháp → chọn nghĩa</span>
        <span style={{ fontFamily:"Georgia,serif", color:C.purple, fontSize:"0.85rem" }}>{done}/{pairs.length}</span>
      </div>
      {done===pairs.length && <div style={{ background:C.ink, color:C.paper, borderRadius:10, padding:"0.55rem 0.9rem", marginBottom:"0.5rem", textAlign:"center", fontSize:"0.82rem" }}>🎉 Hoàn thành! Nối đúng tất cả {pairs.length} cặp</div>}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0.45rem" }}>
        <div>
          <div style={{ fontSize:"0.6rem", textTransform:"uppercase", letterSpacing:1, color:C.gray, marginBottom:"0.27rem" }}>Tiếng Pháp</div>
          {pairs.map((p,i) => { const isM=!!matched[p.fr],isSel=selFr===p.fr,isW=wrongKey&&wrongKey.startsWith(p.fr+"|"); return <div key={i} onClick={()=>clickFr(p.fr)} style={{ padding:"0.43rem 0.62rem", border:`1.5px solid ${isM?C.green:isSel?C.purple:isW?C.red:C.border}`, borderRadius:8, marginBottom:"0.28rem", fontSize:"0.78rem", cursor:isM?"default":"pointer", background:isM?"#e8f7f1":isSel?C.purpleL:C.white, color:isM?C.green:isSel?C.purple:C.ink, transition:"all 0.15s", userSelect:"none" }}>{p.fr}</div>; })}
        </div>
        <div>
          <div style={{ fontSize:"0.6rem", textTransform:"uppercase", letterSpacing:1, color:C.gray, marginBottom:"0.27rem" }}>Tiếng Việt</div>
          {shuffled.map((p,i) => { const isM=!!matched[p.fr],isW=wrongKey&&wrongKey.endsWith("|"+p.fr); return <div key={i} onClick={()=>clickVi(p)} style={{ padding:"0.43rem 0.62rem", border:`1.5px solid ${isM?C.green:isW?C.red:C.border}`, borderRadius:8, marginBottom:"0.28rem", fontSize:"0.78rem", cursor:isM?"default":"pointer", background:isM?"#e8f7f1":C.white, color:isM?C.green:C.ink, transition:"all 0.15s", userSelect:"none" }}>{p.vi}</div>; })}
        </div>
      </div>
    </div>
  );
}

// ── Dictée ─────────────────────────────────────────────────
function DicteeSection({ words, onRecord }) {
  const [idx, setIdx] = useState(0);
  const [input, setInput] = useState("");
  const [checked, setChecked] = useState(false);
  const [score, setScore] = useState({ ok:0, total:0 });
  const [revealed, setRevealed] = useState(false);
  const w = words[idx];
  const isCorrect = checked && input.trim().toLowerCase()===w.fr.toLowerCase();
  const check = () => {
    if (checked) return;
    const ok = input.trim().toLowerCase()===w.fr.toLowerCase();
    setChecked(true);
    setScore(s=>({ok:s.ok+(ok?1:0),total:s.total+1}));
    onRecord?.(w.fr, ok);
  };
  const next = () => { setIdx(i=>Math.min(i+1,words.length-1)); setInput(""); setChecked(false); setRevealed(false); };
  const hint = w.fr.split(" ").map(word => word.length<=2?word:word[0]+"*".repeat(word.length-2)+word[word.length-1]).join(" ");
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.7rem" }}>
        <SecLabel icon="🎧" text="Dictée" />
        <span style={{ fontFamily:"Georgia,serif", color:C.purple, fontSize:"0.88rem" }}>{score.ok}/{score.total}</span>
      </div>
      <div style={{ background:C.white, border:`1.5px solid ${checked?(isCorrect?C.green:C.red):C.border}`, borderRadius:12, padding:"1.5rem 1rem", textAlign:"center", marginBottom:"0.8rem" }}>
        <div style={{ fontSize:"0.65rem", color:C.gray, textTransform:"uppercase", letterSpacing:1, marginBottom:"0.5rem" }}>{idx+1} / {words.length}</div>
        <div style={{ fontFamily:"Georgia,serif", fontSize:"1.3rem", color:C.ink, marginBottom:"1.2rem" }}>{w.vi||"?"}</div>
        <input value={input} disabled={checked} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&check()}
          placeholder="Nhập từ tiếng Pháp..."
          style={{ width:"100%", maxWidth:260, border:`1.5px solid ${checked?(isCorrect?C.green:C.red):C.border}`, borderRadius:8, padding:"0.5rem 0.8rem", fontSize:"1rem", fontFamily:"Georgia,serif", textAlign:"center", outline:"none", background:checked?(isCorrect?"#e8f7f1":"#fde8e6"):C.white, color:checked?(isCorrect?C.green:C.red):C.ink, boxSizing:"border-box" }} />
        {!checked && (
          <div style={{ marginTop:"0.8rem", display:"flex", gap:"0.5rem", justifyContent:"center" }}>
            <button onClick={()=>setRevealed(r=>!r)} style={{ padding:"0.3rem 0.8rem", border:`1px solid ${C.border}`, borderRadius:6, background:C.white, color:C.gray, fontSize:"0.72rem", cursor:"pointer" }}>{revealed?"Ẩn":"💡 Gợi ý"}</button>
            <button onClick={check} style={{ padding:"0.3rem 0.8rem", border:"none", borderRadius:6, background:C.ink, color:C.white, fontSize:"0.72rem", cursor:"pointer" }}>Kiểm tra</button>
          </div>
        )}
        {revealed && !checked && <div style={{ marginTop:"0.5rem", fontSize:"0.88rem", color:C.gold, fontFamily:"Georgia,serif", letterSpacing:"0.1em" }}>{hint}</div>}
        {checked && (
          <div style={{ marginTop:"0.7rem" }}>
            <div style={{ fontSize:"0.82rem", color:isCorrect?C.green:C.red, marginBottom:"0.3rem" }}>
              {isCorrect?"✓ Chính xác!":<>✗ Đáp án: <b style={{fontFamily:"Georgia,serif"}}>{w.fr}</b></>}
            </div>
            {idx<words.length-1 && <button onClick={next} style={{ padding:"0.35rem 1rem", border:"none", borderRadius:6, background:C.purple, color:C.white, fontSize:"0.78rem", cursor:"pointer" }}>Tiếp theo →</button>}
            {idx===words.length-1 && <div style={{ color:C.purple, fontFamily:"Georgia,serif" }}>🎉 Xong! {score.ok+1}/{words.length} đúng</div>}
          </div>
        )}
      </div>
      {!checked && idx<words.length-1 && <div style={{ textAlign:"right" }}><button onClick={next} style={{ padding:"0.3rem 0.8rem", border:`1px solid ${C.border}`, borderRadius:6, background:C.white, color:C.gray, fontSize:"0.72rem", cursor:"pointer" }}>Bỏ qua →</button></div>}
    </div>
  );
}

// ── Flashcard ───────────────────────────────────────────────
function FlashcardSection({ words, onRecord }) {
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState("show");
  const [input, setInput] = useState("");
  const [result, setResult] = useState(null);
  const [score, setScore] = useState({ ok:0, total:0 });
  const [timeLeft, setTimeLeft] = useState(3);
  const w = words[idx];

  useEffect(() => {
    if (phase!=="show") return;
    setTimeLeft(3);
    const iv = setInterval(()=>setTimeLeft(t=>{ if(t<=1){clearInterval(iv);setPhase("type");return 0;} return t-1; }),1000);
    return ()=>clearInterval(iv);
  }, [phase, idx]);

  const check = () => {
    const ok = input.trim().toLowerCase()===w.fr.toLowerCase();
    setResult(ok); setPhase("result");
    setScore(s=>({ok:s.ok+(ok?1:0),total:s.total+1}));
    onRecord?.(w.fr, ok);
  };
  const next = () => { setIdx(i=>Math.min(i+1,words.length-1)); setInput(""); setResult(null); setPhase("show"); };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.7rem" }}>
        <SecLabel icon="🃏" text="Flashcard" />
        <span style={{ fontFamily:"Georgia,serif", color:C.purple, fontSize:"0.88rem" }}>{score.ok}/{score.total}</span>
      </div>
      <div style={{ background:C.white, border:`1.5px solid ${phase==="result"?(result?C.green:C.red):C.border}`, borderRadius:12, padding:"1.5rem 1rem", textAlign:"center" }}>
        <div style={{ fontSize:"0.65rem", color:C.gray, textTransform:"uppercase", letterSpacing:1, marginBottom:"0.7rem" }}>{idx+1} / {words.length}</div>
        {phase==="show" && <>
          <div style={{ fontFamily:"Georgia,serif", fontSize:"1.5rem", color:C.purple, marginBottom:"0.3rem" }}>{w.fr} <SpeakBtn text={w.fr} size="1rem"/></div>
          {w.vi && <div style={{ fontSize:"0.82rem", color:C.gray }}>{w.vi}</div>}
          <div style={{ marginTop:"1rem", display:"flex", alignItems:"center", justifyContent:"center", gap:"0.5rem" }}>
            <div style={{ width:36, height:36, borderRadius:"50%", border:`3px solid ${C.purple}`, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"Georgia,serif", fontSize:"1.1rem", color:C.purple, fontWeight:600 }}>{timeLeft}</div>
            <span style={{ fontSize:"0.72rem", color:C.gray }}>Ghi nhớ...</span>
          </div>
        </>}
        {phase==="type" && <>
          <div style={{ fontFamily:"Georgia,serif", fontSize:"1rem", color:C.gray, marginBottom:"0.8rem" }}>Viết lại từ vừa thấy:</div>
          <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&check()} autoFocus
            placeholder="Nhập từ tiếng Pháp..."
            style={{ width:"100%", maxWidth:260, border:`1.5px solid ${C.border}`, borderRadius:8, padding:"0.5rem 0.8rem", fontSize:"1rem", fontFamily:"Georgia,serif", textAlign:"center", outline:"none", boxSizing:"border-box" }} />
          <div style={{ marginTop:"0.8rem" }}><button onClick={check} style={{ padding:"0.35rem 1rem", border:"none", borderRadius:6, background:C.ink, color:C.white, fontSize:"0.78rem", cursor:"pointer" }}>Kiểm tra</button></div>
        </>}
        {phase==="result" && <>
          <div style={{ fontFamily:"Georgia,serif", fontSize:"1.3rem", color:result?C.green:C.red, marginBottom:"0.3rem" }}>{input||"—"}</div>
          {!result && <div style={{ fontSize:"0.82rem", color:C.green, marginBottom:"0.3rem" }}>✓ Đúng: <b>{w.fr}</b></div>}
          <div style={{ fontSize:"0.78rem", color:result?C.green:C.red, marginBottom:"0.8rem" }}>{result?"✓ Chính xác!":"✗ Chưa đúng"}</div>
          {idx<words.length-1 ? <button onClick={next} style={{ padding:"0.35rem 1rem", border:"none", borderRadius:6, background:C.purple, color:C.white, fontSize:"0.78rem", cursor:"pointer" }}>Tiếp theo →</button>
            : <div style={{ color:C.purple, fontFamily:"Georgia,serif" }}>🎉 Xong! {score.ok+(result?1:0)}/{words.length} đúng</div>}
        </>}
      </div>
    </div>
  );
}

// ── Anagramme ───────────────────────────────────────────────
function AnagrammeSection({ words, onRecord }) {
  const [idx, setIdx] = useState(0);
  const [tiles, setTiles] = useState(()=>[...words[0].fr].sort(()=>Math.random()-0.5));
  const [answer, setAnswer] = useState([]);
  const [checked, setChecked] = useState(false);
  const [score, setScore] = useState({ok:0,total:0});
  const w = words[idx];
  const isCorrect = checked && answer.join("")===w.fr;
  const reset = word => { setTiles([...word].sort(()=>Math.random()-0.5)); setAnswer([]); setChecked(false); };
  const next = () => { const ni=Math.min(idx+1,words.length-1); setIdx(ni); reset(words[ni].fr); };
  const clickTile = i => { if(checked)return; setAnswer(a=>[...a,tiles[i]]); setTiles(t=>t.filter((_,j)=>j!==i)); };
  const clickAns = i => { if(checked)return; setTiles(t=>[...t,answer[i]]); setAnswer(a=>a.filter((_,j)=>j!==i)); };
  const check = () => {
    if (checked) return;
    const ok = answer.join("")===w.fr;
    setChecked(true); setScore(s=>({ok:s.ok+(ok?1:0),total:s.total+1}));
    onRecord?.(w.fr, ok);
  };
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.7rem" }}>
        <SecLabel icon="🔀" text="Anagramme" />
        <span style={{ fontFamily:"Georgia,serif", color:C.purple, fontSize:"0.88rem" }}>{score.ok}/{score.total}</span>
      </div>
      <div style={{ background:C.white, border:`1.5px solid ${checked?(isCorrect?C.green:C.red):C.border}`, borderRadius:12, padding:"1.2rem 1rem", textAlign:"center" }}>
        <div style={{ fontSize:"0.65rem", color:C.gray, textTransform:"uppercase", letterSpacing:1, marginBottom:"0.5rem" }}>{idx+1} / {words.length}</div>
        {w.vi && <div style={{ fontFamily:"Georgia,serif", fontSize:"1.1rem", color:C.ink, marginBottom:"1rem" }}>{w.vi}</div>}
        <div style={{ minHeight:44, display:"flex", flexWrap:"wrap", gap:"0.3rem", justifyContent:"center", marginBottom:"0.8rem", padding:"0.5rem", background:C.purpleL, borderRadius:8 }}>
          {answer.length===0 && <span style={{ color:C.gray, fontSize:"0.78rem", alignSelf:"center" }}>Chọn chữ cái...</span>}
          {answer.map((ch,i)=><div key={i} onClick={()=>clickAns(i)} style={{ width:34,height:34,border:`1.5px solid ${C.purple}`,borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"Georgia,serif",fontSize:"1rem",color:C.purple,background:C.white,cursor:checked?"default":"pointer",fontWeight:600 }}>{ch}</div>)}
        </div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:"0.3rem", justifyContent:"center", marginBottom:"1rem" }}>
          {tiles.map((ch,i)=><div key={i} onClick={()=>clickTile(i)} style={{ width:34,height:34,border:`1.5px solid ${C.border}`,borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"Georgia,serif",fontSize:"1rem",color:C.ink,background:C.white,cursor:checked?"default":"pointer",opacity:checked?0.4:1 }}>{ch}</div>)}
        </div>
        <div style={{ display:"flex", gap:"0.5rem", justifyContent:"center" }}>
          {!checked && tiles.length===0 && <button onClick={check} style={{ padding:"0.38rem 1.2rem", border:"none", borderRadius:6, background:C.ink, color:C.white, fontSize:"0.78rem", cursor:"pointer" }}>Kiểm tra</button>}
          {!checked && <button onClick={()=>reset(w.fr)} style={{ padding:"0.38rem 0.8rem", border:`1px solid ${C.border}`, borderRadius:6, background:C.white, color:C.gray, fontSize:"0.72rem", cursor:"pointer" }}>↺ Reset</button>}
        </div>
        {checked && <div style={{ marginTop:"0.6rem" }}>
          <div style={{ fontSize:"0.82rem", color:isCorrect?C.green:C.red, marginBottom:"0.4rem" }}>{isCorrect?"✓ Chính xác!":<>✗ Đáp án: <b style={{fontFamily:"Georgia,serif"}}>{w.fr}</b></>}</div>
          {idx<words.length-1 && <button onClick={next} style={{ padding:"0.35rem 1rem", border:"none", borderRadius:6, background:C.purple, color:C.white, fontSize:"0.78rem", cursor:"pointer" }}>Tiếp theo →</button>}
          {idx===words.length-1 && <div style={{ color:C.purple, fontFamily:"Georgia,serif" }}>🎉 Xong! {score.ok+(isCorrect?1:0)}/{words.length} đúng</div>}
        </div>}
      </div>
    </div>
  );
}

// ── Example Card ───────────────────────────────────────────
function ExampleCard({ word }) {
  const [state, setState] = useState("idle");
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const gen = async () => {
    setState("loading");
    try {
      const r = await callAI(`French teacher. For "${word.fr}"${word.vi?` (${word.vi})`:""},  create 2 example sentences.\nReturn ONLY JSON: {"sentences":[{"fr":"French sentence","vi":"Vietnamese translation","breakdown":[{"token":"word or chunk","role":"grammatical role in Vietnamese","note":"brief note or empty"}]}]}`);
      setData(r); setState("done");
    } catch(e) { setErr(e.message); setState("error"); }
  };
  return (
    <div style={{ background:C.white, border:`1.5px solid ${C.border}`, borderRadius:12, marginBottom:"0.55rem", overflow:"hidden" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"0.65rem 0.95rem", borderBottom:state==="done"?`1px solid ${C.border}`:"none" }}>
        <div><span style={{ fontFamily:"Georgia,serif", fontSize:"0.92rem" }}>{word.fr}</span>{word.vi&&<span style={{ fontSize:"0.75rem", color:C.gray, marginLeft:"0.5rem" }}>— {word.vi}</span>}</div>
        {state==="idle"&&<button onClick={gen} style={{ padding:"0.25rem 0.58rem", background:C.purple, color:C.white, border:"none", borderRadius:6, fontSize:"0.7rem", cursor:"pointer" }}>Tạo ví dụ ✦</button>}
        {state==="loading"&&<div style={{ display:"flex", alignItems:"center", gap:"0.35rem", fontSize:"0.7rem", color:C.gray }}><div style={{ width:13,height:13,border:`2px solid ${C.border}`,borderTopColor:C.purple,borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>Đang tạo...</div>}
        {state==="done"&&<button onClick={()=>{setState("idle");setData(null);}} style={{ padding:"0.22rem 0.55rem", background:"transparent", color:C.gray, border:`1px solid ${C.border}`, borderRadius:6, fontSize:"0.67rem", cursor:"pointer" }}>Ẩn</button>}
        {state==="error"&&<button onClick={gen} style={{ padding:"0.22rem 0.55rem", background:"transparent", color:C.red, border:`1px solid ${C.red}`, borderRadius:6, fontSize:"0.67rem", cursor:"pointer" }}>Thử lại</button>}
      </div>
      {state==="error"&&<div style={{ padding:"0.5rem 0.95rem", fontSize:"0.72rem", color:C.red }}>⚠ {err}</div>}
      {state==="done"&&data?.sentences&&(
        <div style={{ padding:"0.65rem 0.95rem", display:"flex", flexDirection:"column", gap:"0.9rem" }}>
          {data.sentences.map((s,si)=>(
            <div key={si}>
              <div style={{ fontFamily:"Georgia,serif", fontSize:"0.92rem", lineHeight:1.5, marginBottom:"0.16rem" }}>{s.fr}</div>
              <div style={{ fontSize:"0.75rem", color:C.gray, fontStyle:"italic", marginBottom:"0.48rem" }}>→ {s.vi}</div>
              {s.breakdown?.length>0&&<div style={{ display:"flex", flexWrap:"wrap", gap:"0.28rem" }}>
                {s.breakdown.map((tok,ti)=>(
                  <div key={ti} style={{ background:C.purpleL, border:"1px solid #d4c5f5", borderRadius:7, padding:"0.27rem 0.48rem" }}>
                    <div style={{ fontFamily:"Georgia,serif", fontSize:"0.8rem", color:C.purple, fontWeight:600 }}>{tok.token}</div>
                    <div style={{ fontSize:"0.6rem", color:C.gray, marginTop:"0.07rem" }}>{tok.role}</div>
                    {tok.note&&<div style={{ fontSize:"0.58rem", color:"#7a5cb0", marginTop:"0.05rem" }}>{tok.note}</div>}
                  </div>
                ))}
              </div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Import Modal ───────────────────────────────────────────
function ImportModal({ onImport, onClose }) {
  const [state, setState] = useState("idle");
  const [preview, setPreview] = useState("");
  const [err, setErr] = useState("");

  const processFile = async file => {
    setState("loading"); setErr("");
    try {
      const ext = file.name.split(".").pop().toLowerCase();
      if (ext==="txt") { setPreview((await file.text()).trim()); setState("preview"); return; }
      if (ext==="csv") {
        const lines = (await file.text()).split("\n").map(l=>l.trim()).filter(Boolean);
        setPreview(lines.map(l=>{ const p=l.split(/[,;]/).map(x=>x.replace(/^"|"$/g,"").trim()); return p.length>=2?`${p[0]} — ${p[1]}`:p[0]; }).join("\n"));
        setState("preview"); return;
      }
      if (ext==="pdf") {
        if (!window.pdfjsLib) {
          await new Promise((res,rej)=>{ const s=document.createElement("script"); s.src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"; s.onload=res; s.onerror=rej; document.head.appendChild(s); });
          window.pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        }
        const pdf = await window.pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
        let txt=""; for(let i=1;i<=Math.min(pdf.numPages,10);i++){const p=await pdf.getPage(i);const c=await p.getTextContent();txt+=c.items.map(x=>x.str).join(" ")+"\n";}
        const r = await callAI(`Extract French vocabulary from this text. Return each on its own line as: French — Vietnamese. Only the word list.\n\n${txt.slice(0,4000)}`);
        setPreview(typeof r==="string"?r:Object.values(r).join("\n")); setState("preview"); return;
      }
      if (["jpg","jpeg","png","webp","heic","gif"].includes(ext)) {
        const b64 = await new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result.split(",")[1]); r.onerror=rej; r.readAsDataURL(file); });
        const mt = ["jpg","heic"].includes(ext)?"image/jpeg":`image/${ext}`;
        const key = getApiKey(); if(!key) throw new Error("Chưa nhập API key!");
        const res = await fetch("https://api.anthropic.com/v1/messages",{ method:"POST", headers:{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"}, body:JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:1000, system:"Extract vocabulary from image. Return each word on its own line as: French — Vietnamese. Only the word list.", messages:[{role:"user",content:[{type:"image",source:{type:"base64",media_type:mt,data:b64}},{type:"text",text:"Extract vocabulary."}]}] }) });
        const d = await res.json(); if(d.error)throw new Error(d.error.message);
        setPreview(d.content.map(c=>c.text||"").join("").trim()); setState("preview"); return;
      }
      throw new Error(`Định dạng .${ext} chưa hỗ trợ`);
    } catch(e) { setErr(e.message); setState("error"); }
  };

  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:100 }} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ background:C.white,borderRadius:"16px 16px 0 0",padding:"1.25rem",width:"100%",maxWidth:480,maxHeight:"80vh",display:"flex",flexDirection:"column",gap:"0.8rem" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
          <div style={{ fontFamily:"Georgia,serif",fontSize:"1rem",color:C.purple }}>📁 Import từ vựng</div>
          <button onClick={onClose} style={{ background:"transparent",border:"none",fontSize:"1.2rem",cursor:"pointer",color:C.gray }}>×</button>
        </div>
        {(state==="idle"||state==="error")&&<>
          <div onDrop={e=>{e.preventDefault();e.dataTransfer.files[0]&&processFile(e.dataTransfer.files[0]);}} onDragOver={e=>e.preventDefault()}
            style={{ border:`2px dashed ${C.border}`,borderRadius:12,padding:"1.5rem 1rem",textAlign:"center",color:C.gray,fontSize:"0.82rem",lineHeight:1.8 }}>
            <div style={{ fontSize:"1.8rem",marginBottom:"0.3rem" }}>📂</div>Kéo thả file vào đây<br/><span style={{ fontSize:"0.72rem" }}>hoặc chọn file bên dưới</span>
          </div>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:"0.5rem" }}>
            {[{label:"📄 .txt",accept:".txt",desc:"Mỗi dòng 1 từ"},{label:"📊 .csv",accept:".csv",desc:"2 cột"},{label:"📕 .pdf",accept:".pdf",desc:"Giáo trình"},{label:"🖼️ Ảnh",accept:"image/*",desc:"Chụp bảng từ"}].map(btn=>(
              <label key={btn.accept} style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:"0.2rem",padding:"0.6rem 0.3rem",border:`1.5px solid ${C.border}`,borderRadius:10,cursor:"pointer",fontSize:"0.72rem",color:C.ink,textAlign:"center",background:C.cream }}>
                <span style={{ fontSize:"1.1rem" }}>{btn.label}</span><span style={{ color:C.gray,fontSize:"0.65rem" }}>{btn.desc}</span>
                <input type="file" accept={btn.accept} style={{ display:"none" }} onChange={e=>e.target.files[0]&&processFile(e.target.files[0])} />
              </label>
            ))}
          </div>
          {state==="error"&&<div style={{ color:C.red,fontSize:"0.75rem",padding:"0.4rem 0.6rem",background:"#fde8e6",borderRadius:6 }}>⚠ {err}</div>}
        </>}
        {state==="loading"&&<div style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:"0.7rem",padding:"1.5rem",color:C.gray }}><Spinner/><span style={{ fontSize:"0.83rem" }}>Đang đọc file...</span></div>}
        {state==="preview"&&<>
          <div style={{ fontSize:"0.72rem",color:C.gray }}>Xem lại trước khi import:</div>
          <textarea value={preview} onChange={e=>setPreview(e.target.value)} style={{ width:"100%",height:180,border:`1.5px solid ${C.border}`,borderRadius:8,padding:"0.55rem",fontFamily:"inherit",fontSize:"0.78rem",lineHeight:1.6,outline:"none",resize:"none",boxSizing:"border-box",overflowY:"auto" }} />
          <div style={{ display:"flex",gap:"0.5rem" }}>
            <button onClick={()=>setState("idle")} style={{ flex:1,padding:"0.6rem",border:`1.5px solid ${C.border}`,borderRadius:8,background:C.white,color:C.gray,fontSize:"0.83rem",cursor:"pointer" }}>← Chọn lại</button>
            <button onClick={()=>{onImport(preview);onClose();}} style={{ flex:2,padding:"0.6rem",border:"none",borderRadius:8,background:C.purple,color:C.white,fontSize:"0.83rem",cursor:"pointer",fontFamily:"Georgia,serif" }}>Import {preview.split("\n").filter(Boolean).length} từ ✦</button>
          </div>
        </>}
      </div>
    </div>
  );
}

// ── Save Modal ─────────────────────────────────────────────
function SaveModal({ text, onSave, onClose }) {
  const [name, setName] = useState("");
  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,padding:"1rem" }} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ background:C.white,borderRadius:16,padding:"1.5rem",width:"100%",maxWidth:360,display:"flex",flexDirection:"column",gap:"0.8rem" }}>
        <div style={{ fontFamily:"Georgia,serif",fontSize:"1rem",color:C.purple }}>💾 Lưu bộ từ</div>
        <input value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&name.trim()&&onSave(name.trim())}
          placeholder="Tên bộ từ (vd: Chủ đề nghề nghiệp)" autoFocus
          style={{ border:`1.5px solid ${C.border}`,borderRadius:8,padding:"0.6rem 0.8rem",fontSize:"0.88rem",outline:"none",fontFamily:"inherit" }} />
        <div style={{ display:"flex",gap:"0.5rem" }}>
          <button onClick={onClose} style={{ flex:1,padding:"0.6rem",border:`1.5px solid ${C.border}`,borderRadius:8,background:C.white,color:C.gray,fontSize:"0.83rem",cursor:"pointer" }}>Huỷ</button>
          <button onClick={()=>name.trim()&&onSave(name.trim())} style={{ flex:2,padding:"0.6rem",border:"none",borderRadius:8,background:C.purple,color:C.white,fontSize:"0.83rem",cursor:"pointer",fontFamily:"Georgia,serif" }}>Lưu ✦</button>
        </div>
      </div>
    </div>
  );
}

// ── Export PDF ─────────────────────────────────────────────
function exportFillPDF(quiz) {
  const questions = quiz.type==="fill_blank"?quiz.questions:quiz.type==="mixed"?quiz.sections?.find(s=>s.sectionType==="fill_blank")?.questions:null;
  if (!questions?.length) return;
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Bài điền từ</title><style>body{font-family:Georgia,serif;max-width:680px;margin:40px auto;color:#1a1a2e}h1{font-size:1.3rem;color:#6b4fbb;border-bottom:2px solid #c9a84c;padding-bottom:8px;margin-bottom:8px}.meta{font-size:0.75rem;color:#8a8a9a;margin-bottom:28px;font-family:system-ui}.q{margin-bottom:28px}.qnum{font-size:0.62rem;text-transform:uppercase;letter-spacing:1px;color:#8a8a9a;margin-bottom:4px;font-family:system-ui}.hint{color:#c9a84c;margin-left:8px;text-transform:none}.sentence{font-size:1rem;line-height:2}.blank{display:inline-block;min-width:110px;border-bottom:1.5px solid #1a1a2e;margin:0 3px}.writeline{font-size:0.72rem;color:#aaa;font-family:system-ui;margin-top:4px}.answers{margin-top:40px;padding-top:16px;border-top:1px dashed #ddd8cc;page-break-before:always}.answers h2{font-size:0.95rem;color:#6b4fbb;margin-bottom:10px}.answers p{font-size:0.82rem;line-height:2.2;font-family:system-ui}@media print{body{margin:20px}}</style></head><body><h1>✏️ Bài tập điền từ — Français</h1><div class="meta">Ngày: ${new Date().toLocaleDateString("vi-VN")} · ${questions.length} câu</div>${questions.map((q,i)=>`<div class="q"><div class="qnum">Câu ${i+1}${q.hint?`<span class="hint">· gợi ý: ${q.hint}</span>`:""}</div><div class="sentence">${(q.sentence||"").replace("___",'<span class="blank">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>')}</div><div class="writeline">Trả lời: _________________________________</div></div>`).join("")}<div class="answers"><h2>Đáp án</h2><p>${questions.map((q,i)=>`Câu ${i+1}: <b>${q.answer}</b>`).join(" · ")}</p></div></body></html>`;
  const blob=new Blob([html],{type:"text/html;charset=utf-8"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a"); a.href=url; a.download=`bai-dien-tu-${new Date().toISOString().slice(0,10)}.html`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

// ── Analyse Panel ──────────────────────────────────────────
const ANALYSE_HISTORY_KEY = "analyse_history";
async function loadAnalyseHistory() {
  try { return JSON.parse(localStorage.getItem(ANALYSE_HISTORY_KEY)||"[]"); } catch { return []; }
}
async function saveAnalyseHistory(h) {
  try { localStorage.setItem(ANALYSE_HISTORY_KEY, JSON.stringify(h.slice(0,20))); } catch {}
}

function AnalysePanel() {
  const [state, setState] = useState("idle"); // idle | loading | done | error | history | exercises
  const [result, setResult] = useState(null);
  const [err, setErr] = useState("");
  const [inputText, setInputText] = useState("");
  const [activeTab, setActiveTab] = useState("vocab");
  const [history, setHistory] = useState([]);
  const [exercises, setExercises] = useState(null);
  const [exLoading, setExLoading] = useState(false);
  const [exType, setExType] = useState("mixed");

  useEffect(() => { loadAnalyseHistory().then(setHistory); }, []);

  const saveToHistory = (res, text) => {
    const entry = {
      id: Date.now(),
      date: new Date().toLocaleDateString("vi-VN"),
      summary: res.summary || text.slice(0,80)+"...",
      level: res.level || "",
      result: res,
      inputText: text,
    };
    const updated = [entry, ...history].slice(0, 20);
    setHistory(updated);
    saveAnalyseHistory(updated);
  };

  const analyse = async (content) => {
    setState("loading"); setResult(null); setErr(""); setExercises(null);
    try {
      const prompt = `Tu es un professeur de français expert. Analyse ce texte français et réponds en JSON.
Texte: """${content.slice(0, 4000)}"""

Retourne UNIQUEMENT ce JSON:
{
  "translation": "Bản dịch tiếng Việt đầy đủ. Xuống dòng bằng \\n khi cần thiết.",
  "summary": "Tóm tắt nội dung bằng tiếng Việt (2-3 câu)",
  "level": "Trình độ ước tính A1/A2/B1/B2/C1/C2",
  "vocab": [{"fr":"từ","type":"n.m/n.f/v/adj/adv/prep/expr","vi":"nghĩa","example":"câu ví dụ"}],
  "grammar": [{"point":"điểm ngữ pháp","explanation":"giải thích tiếng Việt","example":"câu ví dụ"}],
  "notes": [{"type":"Phong cách/Văn hóa/Lưu ý/Thành ngữ","content":"nội dung"}]
}
Chọn 15-20 từ vựng quan trọng nhất và 4-6 điểm ngữ pháp nổi bật.`;
      const res = await callAI(prompt);
      setResult(res);
      setState("done");
      setActiveTab("vocab");
      saveToHistory(res, content);
    } catch(e) { setErr(e.message); setState("error"); }
  };

  const handleFile = async (file) => {
    const ext = file.name.split(".").pop().toLowerCase();
    setState("loading");
    try {
      if (ext==="txt") { const t=await file.text(); setInputText(t); await analyse(t); }
      else if (ext==="pdf") {
        if (!window.pdfjsLib) {
          await new Promise((res,rej)=>{ const s=document.createElement("script"); s.src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"; s.onload=res; s.onerror=rej; document.head.appendChild(s); });
          window.pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        }
        const pdf=await window.pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
        let txt=""; for(let i=1;i<=Math.min(pdf.numPages,5);i++){const p=await pdf.getPage(i);const c=await p.getTextContent();txt+=c.items.map(x=>x.str).join(" ")+"\n";}
        setInputText(txt); await analyse(txt);
      } else if (["jpg","jpeg","png","webp"].includes(ext)) {
        const b64=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result.split(",")[1]);r.onerror=rej;r.readAsDataURL(file);});
        const mt=ext==="jpg"?"image/jpeg":`image/${ext}`;
        const extractRes=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":getApiKey(),"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:3000,system:"Extract all French text from this image exactly as written. Return only the text.",messages:[{role:"user",content:[{type:"image",source:{type:"base64",media_type:mt,data:b64}},{type:"text",text:"Extract French text."}]}]})});
        const ed=await extractRes.json(); if(ed.error)throw new Error(ed.error.message);
        const t=ed.content.map(c=>c.text||"").join("").trim();
        setInputText(t); await analyse(t);
      } else throw new Error(`Định dạng .${ext} chưa hỗ trợ`);
    } catch(e) { setErr(e.message); setState("error"); }
  };

  // ── Generate exercises from analysis ──
  const generateExercises = async () => {
    if (!result) return;
    setExLoading(true); setExercises(null);
    try {
      const vocabList = (result.vocab||[]).map(w=>`${w.fr} — ${w.vi}`).join("\n");
      const grammarPoints = (result.grammar||[]).map(g=>g.point).join(", ");
      let prompt = "";
      if (exType==="vocab_fr_vi" || exType==="mixed") {
        prompt = `French teacher. Create 8 multiple choice questions testing vocabulary translation (FR→VI and VI→FR mixed).
Vocabulary from text: ${vocabList}
Return ONLY JSON: {"type":"multiple_choice","questions":[{"question":"...","options":["A","B","C","D"],"answer":"exact option","explanation":"Vietnamese tip","wrongExplanations":{"wrong option":"what it means"}}]}`;
      }
      if (exType==="grammar") {
        prompt = `French teacher. Create 6 grammar exercises based on these grammar points: ${grammarPoints}.
Use examples from or inspired by this text context.
Return ONLY JSON: {"type":"mixed","sections":[{"sectionType":"mc","exercises":[{"question":"...","options":["a","b","c","d"],"answer":"correct","explanation":"Vietnamese why"}]},{"sectionType":"fill","exercises":[{"sentence":"sentence with ___","answer":"word","hint":"Vietnamese hint","explanation":"why"}]}]}`;
      }
      if (exType==="mixed") {
        // For mixed, we already set vocab prompt above, now also get grammar
        const vocabRes = await callAI(prompt);
        const grammarPrompt = `French teacher. Create 4 grammar exercises based on: ${grammarPoints}.
Return ONLY JSON: {"type":"mixed","sections":[{"sectionType":"mc","exercises":[{"question":"...","options":["a","b","c","d"],"answer":"correct","explanation":"Vietnamese why"}]},{"sectionType":"fill","exercises":[{"sentence":"sentence with ___","answer":"word","hint":"hint","explanation":"why"}]}]}`;
        const grammarRes = await callAI(grammarPrompt);
        setExercises({ type:"combined", vocab: vocabRes, grammar: grammarRes });
        setExLoading(false); setState("exercises"); return;
      }
      const res = await callAI(prompt);
      setExercises(res);
      setState("exercises");
    } catch(e) { setErr(e.message); }
    setExLoading(false);
  };

  // ── Type colors ──
  const typeColor = t => ({"n.m":"#6b4fbb","n.f":"#c0392b","v":"#3d8b6f","adj":"#c9a84c","adv":"#2980b9","prep":"#8a8a9a","expr":"#e67e22"}[t]||C.gray);

  // ── Export PDF ──
  const exportPDF = () => {
    if (!result) return;
    const date = new Date().toLocaleDateString("vi-VN");
    const vocabRows = (result.vocab||[]).map((w,i)=>`<tr style="background:${i%2===0?"#faf8f4":"#fff"}"><td style="padding:8px 12px;font-family:Georgia,serif;font-weight:600;color:#1a1a2e">${w.fr}</td><td style="padding:8px 12px;text-align:center"><span style="background:${typeColor(w.type)}22;color:${typeColor(w.type)};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">${w.type||""}</span></td><td style="padding:8px 12px;color:#1a1a2e">${w.vi}</td><td style="padding:8px 12px;color:#666;font-style:italic;font-size:12px">${w.example||""}</td></tr>`).join("");
    const grammarItems = (result.grammar||[]).map(g=>`<div style="background:#fff;border:1px solid #ddd8cc;border-radius:10px;padding:14px 16px;margin-bottom:10px"><div style="font-family:Georgia,serif;color:#6b4fbb;font-size:15px;margin-bottom:6px">🧩 ${g.point}</div><div style="color:#1a1a2e;line-height:1.7;font-size:13px;margin-bottom:8px">${g.explanation}</div>${g.example?`<div style="background:#ede8f8;padding:8px 12px;border-radius:6px;font-style:italic;color:#555;font-size:12px">« ${g.example} »</div>`:""}</div>`).join("");
    const notesItems = (result.notes||[]).map(n=>`<div style="background:#fff;border:1px solid #ddd8cc;border-radius:10px;padding:14px 16px;margin-bottom:10px"><div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#c9a84c;font-weight:700;margin-bottom:6px">${n.type}</div><div style="color:#1a1a2e;line-height:1.7;font-size:13px">${n.content}</div></div>`).join("");
    // Fix: replace \n with <br> in translation
    const translationHtml = (result.translation||"").replace(/\n/g,"<br>");
    const html=`<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Phân tích — Français</title>
<style>*{box-sizing:border-box}body{font-family:system-ui,sans-serif;max-width:780px;margin:0 auto;padding:32px 24px;color:#1a1a2e;background:#faf8f4}.hdr{background:#1a1a2e;color:#faf8f4;padding:24px 28px;border-radius:14px;margin-bottom:28px}.hdr h1{font-family:Georgia,serif;font-size:22px;margin-bottom:4px}.meta{font-size:12px;color:#a0a0b8}.badge{background:#6b4fbb;color:#fff;padding:3px 10px;border-radius:20px;font-size:11px;margin-left:8px}.gold{width:40px;height:2px;background:#c9a84c;margin:10px 0}.sec{font-family:Georgia,serif;font-size:16px;color:#6b4fbb;border-bottom:2px solid #ede8f8;padding-bottom:8px;margin:28px 0 14px}table{width:100%;border-collapse:collapse;border-radius:10px;overflow:hidden}th{background:#1a1a2e;color:#faf8f4;padding:10px 12px;text-align:left;font-size:12px;font-weight:600}.trans{background:#ede8f8;border-radius:10px;padding:16px;line-height:1.9;font-size:13px}.orig{background:#fff;border:1px solid #ddd8cc;border-radius:10px;padding:16px;line-height:1.8;font-size:13px;font-family:Georgia,serif;margin-bottom:10px;white-space:pre-wrap}@media print{body{padding:20px}}</style>
</head><body>
<div class="hdr"><div class="meta">Français · ${date}</div><div class="gold"></div><h1>Kết quả phân tích<span class="badge">${result.level||""}</span></h1>${result.summary?`<div style="margin-top:10px;font-size:13px;color:#a0a0b8;line-height:1.6">${result.summary}</div>`:""}</div>
<div class="sec">📚 Từ vựng (${(result.vocab||[]).length} từ)</div>
<table><tr><th>Từ tiếng Pháp</th><th style="width:80px;text-align:center">Loại</th><th>Nghĩa</th><th>Ví dụ</th></tr>${vocabRows}</table>
<div class="sec">🧩 Ngữ pháp</div>${grammarItems}
<div class="sec">💡 Điểm lưu ý</div>${notesItems}
<div class="sec">🌐 Bản dịch</div>
${inputText?`<div class="orig">${inputText.slice(0,600)}${inputText.length>600?"...":""}</div>`:""}
<div class="trans">${translationHtml}</div>
</body></html>`;
    const blob=new Blob([html],{type:"text/html;charset=utf-8"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=url; a.download=`phan-tich-${date.replace(/\//g,"-")}.html`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  };

  // ── Render exercises ──
  const renderExercises = () => {
    if (!exercises) return null;
    if (exercises.type==="combined") return (
      <div>
        <div style={{fontFamily:"Georgia,serif",fontSize:"0.9rem",color:C.purple,marginBottom:"0.5rem",paddingBottom:"0.3rem",borderBottom:`1px solid ${C.border}`}}>☑ Từ vựng — Trắc nghiệm</div>
        {exercises.vocab?.questions && <MCSection questions={exercises.vocab.questions} onRecord={()=>{}} />}
        <div style={{fontFamily:"Georgia,serif",fontSize:"0.9rem",color:C.purple,margin:"0.8rem 0 0.5rem",paddingBottom:"0.3rem",borderBottom:`1px solid ${C.border}`}}>🧩 Ngữ pháp</div>
        {exercises.grammar?.sections?.map((sec,i)=>(
          <div key={i}>
            {sec.sectionType==="mc" && sec.exercises && <MCSection questions={sec.exercises.map(e=>({question:e.question,options:e.options,answer:e.answer,explanation:e.explanation}))} onRecord={()=>{}} sl />}
            {sec.sectionType==="fill" && sec.exercises && <FillSection questions={sec.exercises.map(e=>({sentence:e.sentence,answer:e.answer,hint:e.hint}))} onRecord={()=>{}} sl />}
          </div>
        ))}
      </div>
    );
    if (exercises.type==="multiple_choice") return <MCSection questions={exercises.questions} onRecord={()=>{}} />;
    return null;
  };

  // ── History view ──
  if (state==="history") return (
    <div style={{padding:"1rem"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"0.8rem"}}>
        <div style={{fontSize:"0.72rem",fontWeight:600,color:C.green}}>📁 Lịch sử phân tích</div>
        <button onClick={()=>setState("idle")} style={{padding:"0.22rem 0.65rem",background:C.green,color:C.white,border:"none",borderRadius:20,fontSize:"0.65rem",cursor:"pointer"}}>+ Phân tích mới</button>
      </div>
      {history.length===0
        ? <div style={{textAlign:"center",color:C.gray,fontSize:"0.85rem",padding:"2rem"}}>Chưa có lịch sử phân tích nào.</div>
        : history.map(h=>(
          <div key={h.id} style={{background:C.white,border:`1.5px solid ${C.border}`,borderRadius:12,padding:"0.8rem 1rem",marginBottom:"0.5rem"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div style={{flex:1,marginRight:"0.5rem"}}>
                {h.level && <span style={{background:C.purple,color:C.white,fontSize:"0.6rem",padding:"0.12rem 0.45rem",borderRadius:20,marginRight:"0.4rem"}}>{h.level}</span>}
                <span style={{fontSize:"0.65rem",color:C.gray}}>{h.date}</span>
                <div style={{fontSize:"0.8rem",color:C.ink,marginTop:"0.3rem",lineHeight:1.5}}>{h.summary}</div>
                <div style={{fontSize:"0.65rem",color:C.gray,marginTop:"0.2rem"}}>{h.result?.vocab?.length||0} từ · {h.result?.grammar?.length||0} điểm ngữ pháp</div>
              </div>
              <div style={{display:"flex",gap:"0.3rem",flexShrink:0}}>
                <button onClick={()=>{setResult(h.result);setInputText(h.inputText||"");setState("done");setActiveTab("vocab");}}
                  style={{padding:"0.25rem 0.6rem",background:C.green,color:C.white,border:"none",borderRadius:6,fontSize:"0.7rem",cursor:"pointer"}}>Xem</button>
                <button onClick={()=>{const u=history.filter(x=>x.id!==h.id);setHistory(u);saveAnalyseHistory(u);}}
                  style={{padding:"0.25rem 0.5rem",background:"transparent",color:C.gray,border:`1px solid ${C.border}`,borderRadius:6,fontSize:"0.7rem",cursor:"pointer"}}>🗑</button>
              </div>
            </div>
          </div>
        ))
      }
    </div>
  );

  // ── Exercise view ──
  if (state==="exercises") return (
    <div style={{padding:"1rem"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"0.8rem"}}>
        <span style={{background:C.green,color:C.white,fontSize:"0.6rem",padding:"0.16rem 0.52rem",borderRadius:20,textTransform:"uppercase",letterSpacing:0.5}}>Bài tập từ văn bản</span>
        <div style={{display:"flex",gap:"0.35rem"}}>
          <button onClick={()=>{setExercises(null);generateExercises();}} style={{padding:"0.23rem 0.6rem",border:`1.5px solid ${C.border}`,borderRadius:20,background:C.white,color:C.ink,fontSize:"0.68rem",cursor:"pointer"}}>🔄 Tạo lại</button>
          <button onClick={()=>setState("done")} style={{padding:"0.23rem 0.6rem",border:`1.5px solid ${C.border}`,borderRadius:20,background:C.white,color:C.ink,fontSize:"0.68rem",cursor:"pointer"}}>← Phân tích</button>
        </div>
      </div>
      {exLoading
        ? <div style={{display:"flex",flexDirection:"column",alignItems:"center",height:180,justifyContent:"center",gap:"0.7rem",color:C.gray}}><Spinner/><span style={{fontSize:"0.83rem"}}>Đang tạo bài tập...</span></div>
        : renderExercises()
      }
    </div>
  );

  return (
    <div style={{padding:"1rem",display:"flex",flexDirection:"column",gap:"0.85rem"}}>

      {/* Upload area */}
      {state!=="done" && (
        <div style={{background:C.cream,borderRadius:12,padding:"0.9rem",display:"flex",flexDirection:"column",gap:"0.65rem"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{fontSize:"0.72rem",fontWeight:600,color:C.green}}>🔍 Phân tích văn bản tiếng Pháp</div>
            <button onClick={()=>setState("history")} style={{padding:"0.22rem 0.6rem",background:"transparent",border:`1px solid ${C.green}`,color:C.green,borderRadius:20,fontSize:"0.65rem",cursor:"pointer"}}>
              📁 Lịch sử ({history.length})
            </button>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"0.35rem"}}>
            {[{label:"📄 .txt",accept:".txt"},{label:"📕 .pdf",accept:".pdf"},{label:"🖼️ Ảnh",accept:"image/*"}].map(btn=>(
              <label key={btn.accept} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:"0.2rem",padding:"0.6rem 0.3rem",border:`1.5px solid ${C.border}`,borderRadius:10,cursor:"pointer",fontSize:"0.72rem",color:C.ink,textAlign:"center",background:C.white}}>
                <span style={{fontSize:"1.1rem"}}>{btn.label}</span>
                <input type="file" accept={btn.accept} style={{display:"none"}} onChange={e=>e.target.files[0]&&handleFile(e.target.files[0])} />
              </label>
            ))}
          </div>
          <div style={{fontSize:"0.65rem",color:C.gray,textAlign:"center"}}>— hoặc dán văn bản trực tiếp —</div>
          <textarea value={inputText} onChange={e=>setInputText(e.target.value)}
            placeholder="Dán văn bản tiếng Pháp vào đây..."
            style={{width:"100%",height:120,border:`1.5px solid ${C.border}`,borderRadius:8,padding:"0.6rem",fontFamily:"inherit",fontSize:"0.82rem",background:C.white,resize:"vertical",color:C.ink,lineHeight:1.6,outline:"none",boxSizing:"border-box"}}/>
          {err&&<div style={{color:C.red,fontSize:"0.75rem",padding:"0.38rem 0.58rem",background:"#fde8e6",borderRadius:6}}>⚠ {err}</div>}
          <button onClick={()=>inputText.trim()&&analyse(inputText)} disabled={!inputText.trim()||state==="loading"}
            style={{padding:"0.75rem",background:!inputText.trim()?C.gray:C.green,color:C.white,border:"none",borderRadius:8,fontFamily:"Georgia,serif",fontSize:"0.92rem",cursor:!inputText.trim()?"not-allowed":"pointer"}}>
            Phân tích ✦
          </button>
        </div>
      )}

      {/* Loading */}
      {state==="loading"&&<div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:200,gap:"0.7rem",color:C.gray}}><Spinner/><span style={{fontSize:"0.83rem"}}>AI đang phân tích...</span></div>}

      {/* Results */}
      {state==="done"&&result&&(
        <>
          {/* Header */}
          <div style={{background:C.ink,color:C.paper,borderRadius:12,padding:"0.8rem 1rem"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div style={{flex:1}}>
                <div style={{fontFamily:"Georgia,serif",fontSize:"0.95rem",marginBottom:"0.2rem"}}>Kết quả phân tích
                  {result.level&&<span style={{background:C.purple,color:C.white,fontSize:"0.6rem",padding:"0.12rem 0.45rem",borderRadius:20,marginLeft:"0.5rem"}}>{result.level}</span>}
                </div>
                {result.summary&&<div style={{fontSize:"0.72rem",color:"#a0a0b8",lineHeight:1.5}}>{result.summary}</div>}
              </div>
              <div style={{display:"flex",gap:"0.3rem",flexShrink:0,marginLeft:"0.5rem"}}>
                <button onClick={exportPDF} style={{fontSize:"0.65rem",color:C.gold,background:"transparent",border:`1px solid ${C.gold}55`,borderRadius:20,padding:"0.2rem 0.55rem",cursor:"pointer"}}>📄 PDF</button>
                <button onClick={()=>setState("history")} style={{fontSize:"0.65rem",color:"#a0a0b8",background:"transparent",border:"1px solid #ffffff33",borderRadius:20,padding:"0.2rem 0.5rem",cursor:"pointer"}}>📁</button>
                <button onClick={()=>{setState("idle");setResult(null);setInputText("");setErr("");}} style={{fontSize:"0.65rem",color:"#a0a0b8",background:"transparent",border:"1px solid #ffffff33",borderRadius:20,padding:"0.2rem 0.5rem",cursor:"pointer"}}>✕</button>
              </div>
            </div>
          </div>

          {/* Exercise generator */}
          <div style={{background:C.purpleL,border:`1px solid #d4c5f5`,borderRadius:12,padding:"0.75rem 1rem"}}>
            <div style={{fontSize:"0.7rem",fontWeight:600,color:C.purple,marginBottom:"0.5rem"}}>🎯 Tạo bài tập từ văn bản này</div>
            <div style={{display:"flex",gap:"0.35rem",marginBottom:"0.5rem",flexWrap:"wrap"}}>
              {[{id:"mixed",label:"🎲 Hỗn hợp"},{id:"vocab_fr_vi",label:"📚 Từ vựng"},{id:"grammar",label:"🧩 Ngữ pháp"}].map(t=>(
                <button key={t.id} onClick={()=>setExType(t.id)}
                  style={{padding:"0.28rem 0.65rem",border:`1.5px solid ${exType===t.id?C.purple:C.border}`,borderRadius:20,background:exType===t.id?C.purple:C.white,color:exType===t.id?C.white:C.ink,fontSize:"0.72rem",cursor:"pointer",fontFamily:"inherit"}}>
                  {t.label}
                </button>
              ))}
            </div>
            <button onClick={generateExercises} disabled={exLoading}
              style={{width:"100%",padding:"0.55rem",background:exLoading?C.gray:C.purple,color:C.white,border:"none",borderRadius:8,fontSize:"0.82rem",cursor:exLoading?"not-allowed":"pointer",fontFamily:"Georgia,serif"}}>
              {exLoading?"Đang tạo...":"Tạo bài tập ✦"}
            </button>
          </div>

          {/* Tabs */}
          <div style={{display:"flex",gap:"0.35rem",overflowX:"auto",paddingBottom:"0.2rem"}}>
            {[{id:"vocab",label:"📚 Từ vựng"},{id:"grammar",label:"🧩 Ngữ pháp"},{id:"notes",label:"💡 Lưu ý"},{id:"trans",label:"🌐 Bản dịch"}].map(t=>(
              <button key={t.id} onClick={()=>setActiveTab(t.id)}
                style={{padding:"0.4rem 0.75rem",border:`1.5px solid ${activeTab===t.id?C.green:C.border}`,borderRadius:20,background:activeTab===t.id?C.green:C.white,color:activeTab===t.id?C.white:C.ink,fontSize:"0.75rem",cursor:"pointer",whiteSpace:"nowrap",fontFamily:"inherit"}}>
                {t.label}
              </button>
            ))}
          </div>

          {/* Vocab tab */}
          {activeTab==="vocab"&&result.vocab&&(
            <div>{result.vocab.map((w,i)=>(
              <div key={i} style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:10,padding:"0.65rem 0.85rem",marginBottom:"0.4rem"}}>
                <div style={{display:"flex",alignItems:"center",gap:"0.5rem",marginBottom:"0.2rem"}}>
                  <span style={{fontFamily:"Georgia,serif",fontSize:"0.92rem",fontWeight:600,color:C.ink}}>{w.fr}</span>
                  {w.type&&<span style={{fontSize:"0.62rem",background:typeColor(w.type)+"22",color:typeColor(w.type),padding:"0.1rem 0.4rem",borderRadius:10,fontWeight:600}}>{w.type}</span>}
                </div>
                <div style={{fontSize:"0.78rem",color:C.ink,marginBottom:"0.15rem"}}>{w.vi}</div>
                {w.example&&<div style={{fontSize:"0.7rem",color:C.gray,fontStyle:"italic"}}>« {w.example} »</div>}
              </div>
            ))}</div>
          )}

          {/* Grammar tab */}
          {activeTab==="grammar"&&result.grammar&&(
            <div>{result.grammar.map((g,i)=>(
              <div key={i} style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:10,padding:"0.65rem 0.85rem",marginBottom:"0.4rem"}}>
                <div style={{fontFamily:"Georgia,serif",fontSize:"0.88rem",color:C.purple,marginBottom:"0.3rem"}}>🧩 {g.point}</div>
                <div style={{fontSize:"0.78rem",color:C.ink,lineHeight:1.6,marginBottom:"0.25rem"}}>{g.explanation}</div>
                {g.example&&<div style={{fontSize:"0.72rem",color:C.gray,fontStyle:"italic",background:C.purpleL,padding:"0.3rem 0.55rem",borderRadius:6}}>« {g.example} »</div>}
              </div>
            ))}</div>
          )}

          {/* Notes tab */}
          {activeTab==="notes"&&result.notes&&(
            <div>{result.notes.map((n,i)=>(
              <div key={i} style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:10,padding:"0.65rem 0.85rem",marginBottom:"0.4rem"}}>
                <div style={{fontSize:"0.65rem",textTransform:"uppercase",letterSpacing:1,color:C.gold,marginBottom:"0.3rem",fontWeight:600}}>{n.type}</div>
                <div style={{fontSize:"0.82rem",color:C.ink,lineHeight:1.6}}>{n.content}</div>
              </div>
            ))}</div>
          )}

          {/* Translation tab */}
          {activeTab==="trans"&&(
            <div>
              {inputText&&<div style={{background:C.white,border:`1px solid ${C.border}`,borderRadius:10,padding:"0.75rem 0.85rem",marginBottom:"0.6rem"}}>
                <div style={{fontSize:"0.63rem",textTransform:"uppercase",letterSpacing:1,color:C.gray,marginBottom:"0.4rem"}}>Văn bản gốc</div>
                <div style={{fontFamily:"Georgia,serif",fontSize:"0.85rem",color:C.ink,lineHeight:1.8,whiteSpace:"pre-wrap"}}>{inputText.slice(0,800)}{inputText.length>800?"...":""}</div>
              </div>}
              <div style={{background:C.purpleL,border:`1px solid #d4c5f5`,borderRadius:10,padding:"0.75rem 0.85rem"}}>
                <div style={{fontSize:"0.63rem",textTransform:"uppercase",letterSpacing:1,color:C.purple,marginBottom:"0.4rem",fontWeight:600}}>Bản dịch tiếng Việt</div>
                <div style={{fontSize:"0.85rem",color:C.ink,lineHeight:1.9,whiteSpace:"pre-wrap"}}>{result.translation}</div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Grammar View ───────────────────────────────────────────
const LEVELS = ["A1","A2","B1","B2","C1","C2"];
const GTYPES = [
  { id:"mc",    label:"☑ Chọn đáp án" },
  { id:"fill",  label:"✏️ Điền vào chỗ trống" },
  { id:"order", label:"🔀 Sắp xếp câu" },
  { id:"mixed", label:"🎲 Hỗn hợp" },
];

function buildGrammarPrompt(topic, level, gtype, n) {
  const base = `French grammar teacher. Create ${n} exercises on the topic: "${topic}" for level ${level}.`;
  if (gtype === "mc") return `${base}\nReturn ONLY JSON: {"type":"mc","topic":"${topic}","level":"${level}","explanation":"brief Vietnamese explanation of this grammar rule in 2-3 sentences","exercises":[{"question":"Full sentence with context","options":["option1","option2","option3","option4"],"answer":"correct option","explanation":"why this is correct in Vietnamese"}]}`;
  if (gtype === "fill") return `${base}\nReturn ONLY JSON: {"type":"fill","topic":"${topic}","level":"${level}","explanation":"brief Vietnamese explanation of this grammar rule","exercises":[{"sentence":"French sentence with ___ for the blank","answer":"correct word/form","hint":"brief Vietnamese hint","explanation":"why this form is correct in Vietnamese"}]}`;
  if (gtype === "order") return `${base} Create sentences where words are scrambled.\nIMPORTANT: The "words" array must NOT contain punctuation (no periods, commas, question marks). Punctuation goes only in "answer".\nReturn ONLY JSON: {"type":"order","topic":"${topic}","level":"${level}","explanation":"brief Vietnamese explanation of this grammar rule","exercises":[{"words":["word1","word2","word3","word4","word5"],"answer":"Correct sentence (may include punctuation)","translation":"Vietnamese translation","explanation":"note about word order in Vietnamese"}]}`;
  if (gtype === "mixed") return `${base} Create a mix: ${Math.ceil(n/3)} multiple choice + ${Math.ceil(n/3)} fill-in-blank + ${Math.floor(n/3)} word order.\nFor word order exercises: "words" array must NOT contain punctuation.\nReturn ONLY JSON: {"type":"mixed","topic":"${topic}","level":"${level}","explanation":"brief Vietnamese explanation","sections":[{"sectionType":"mc","exercises":[{"question":"...","options":["a","b","c","d"],"answer":"correct","explanation":"Vietnamese why"}]},{"sectionType":"fill","exercises":[{"sentence":"sentence with ___","answer":"word","hint":"hint","explanation":"Vietnamese why"}]},{"sectionType":"order","exercises":[{"words":["w1","w2","w3"],"answer":"Correct sentence","translation":"Vietnamese","explanation":"note"}]}`;
  return "";
}

function GrammarMC({ exercises, onWrong }) {
  const [ans, setAns] = useState({});
  return <div>{exercises.map((q,i) => {
    const a = ans[i], ok = a === q.answer;
    return (
      <div key={i} style={{ background:a?(ok?"#f0faf6":"#fdf5f4"):C.white, border:`1.5px solid ${a?(ok?C.green:C.red):C.border}`, borderRadius:12, padding:"0.85rem 1rem", marginBottom:"0.6rem" }}>
        <div style={{ fontSize:"0.63rem", color:C.gray, textTransform:"uppercase", letterSpacing:1, marginBottom:4 }}>Câu {i+1}</div>
        <div style={{ fontFamily:"Georgia,serif", fontSize:"0.93rem", marginBottom:"0.6rem", lineHeight:1.5 }}>{q.question}</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0.3rem" }}>
          {q.options.map((opt,j) => {
            let bg=C.white,bc=C.border,col=C.ink;
            if(a){if(opt===q.answer){bg="#e8f7f1";bc=C.green;col=C.green;}else if(opt===a){bg="#fde8e6";bc=C.red;col=C.red;}}
            return <button key={j} disabled={!!a} onClick={()=>{setAns(x=>({...x,[i]:opt}));if(opt!==q.answer)onWrong?.(q);}}
              style={{padding:"0.42rem 0.55rem",border:`1.5px solid ${bc}`,borderRadius:8,background:bg,color:col,fontSize:"0.78rem",cursor:a?"default":"pointer",textAlign:"left",fontFamily:"inherit"}}>{opt}</button>;
          })}
        </div>
        {a && <div style={{ marginTop:"0.4rem", fontSize:"0.72rem", lineHeight:1.7 }}>
          {ok ? <span style={{color:C.green}}>✓ Chính xác!</span>
              : <><div style={{color:C.red}}>✗ <b>{a}</b></div><div style={{color:C.green}}>✓ <b>{q.answer}</b></div></>}
          {q.explanation && <div style={{color:C.gray,marginTop:"0.2rem"}}>💡 {q.explanation}</div>}
        </div>}
      </div>
    );
  })}</div>;
}

function GrammarFill({ exercises }) {
  const [inp, setInp] = useState({});
  const [chk, setChk] = useState({});
  return <div>{exercises.map((q,i) => {
    const v=inp[i]||"", done=chk[i], ok=done&&v.trim().toLowerCase()===(q.answer||"").toLowerCase();
    return (
      <div key={i} style={{ background:done?(ok?"#f0faf6":"#fdf5f4"):C.white, border:`1.5px solid ${done?(ok?C.green:C.red):C.border}`, borderRadius:12, padding:"0.85rem 1rem", marginBottom:"0.6rem" }}>
        <div style={{ fontSize:"0.63rem", color:C.gray, textTransform:"uppercase", letterSpacing:1, marginBottom:4 }}>
          Câu {i+1}{q.hint?<span style={{color:C.gold,marginLeft:6,textTransform:"none"}}>· {q.hint}</span>:null}
        </div>
        <div style={{ fontFamily:"Georgia,serif", fontSize:"0.9rem", marginBottom:"0.55rem", lineHeight:1.6 }}>{q.sentence}</div>
        <div style={{ display:"flex", gap:"0.38rem", alignItems:"center", flexWrap:"wrap" }}>
          <input value={v} disabled={done} onChange={e=>setInp(x=>({...x,[i]:e.target.value}))}
            onKeyDown={e=>e.key==="Enter"&&!done&&setChk(x=>({...x,[i]:true}))}
            placeholder="Nhập từ / dạng đúng..."
            style={{border:`1.5px solid ${done?(ok?C.green:C.red):C.border}`,borderRadius:6,padding:"0.3rem 0.55rem",fontSize:"0.83rem",width:180,fontFamily:"inherit",background:done?(ok?"#e8f7f1":"#fde8e6"):C.white,color:done?(ok?C.green:C.red):C.ink,outline:"none"}}/>
          {!done&&<button onClick={()=>setChk(x=>({...x,[i]:true}))} style={{padding:"0.3rem 0.65rem",background:C.ink,color:C.white,border:"none",borderRadius:6,fontSize:"0.73rem",cursor:"pointer",fontFamily:"inherit"}}>Kiểm tra</button>}
          {done&&<span style={{fontSize:"0.73rem",color:ok?C.green:C.red,fontWeight:500}}>{ok?"✓ Đúng!":`✗ Đáp án: ${q.answer}`}</span>}
        </div>
        {done&&q.explanation&&<div style={{marginTop:"0.4rem",fontSize:"0.72rem",color:C.gray}}>💡 {q.explanation}</div>}
      </div>
    );
  })}</div>;
}

function GrammarOrder({ exercises }) {
  const init = (words) => words.map((w,i)=>({w,id:i})).sort(()=>Math.random()-0.5);
  const [states, setStates] = useState(()=>exercises.map(q=>({ pool:init(q.words), chosen:[], checked:false })));

  const clickPool = (qi,ti) => {
    if(states[qi].checked) return;
    setStates(prev=>prev.map((s,i)=>i!==qi?s:({...s, pool:s.pool.filter((_,j)=>j!==ti), chosen:[...s.chosen,s.pool[ti]]})));
  };
  const clickChosen = (qi,ti) => {
    if(states[qi].checked) return;
    setStates(prev=>prev.map((s,i)=>i!==qi?s:({...s, chosen:s.chosen.filter((_,j)=>j!==ti), pool:[...s.pool,s.chosen[ti]]})));
  };
  const norm = s => (s||"").trim().toLowerCase().replace(/[''`]/g,"'").replace(/[.,!?;:«»]/g,"").replace(/\s+/g," ");
  const check = (qi) => setStates(prev=>prev.map((s,i)=>i!==qi?s:({...s,checked:true})));
  const reset = (qi) => setStates(prev=>prev.map((s,i)=>i!==qi?s:({...s,pool:init(exercises[qi].words),chosen:[],checked:false})));

  return <div>{exercises.map((q,i) => {
    const s = states[i];
    const answer = s.chosen.map(x=>x.w).join(" ");
    const ok = s.checked && norm(answer) === norm(q.answer);
    return (
      <div key={i} style={{ background:s.checked?(ok?"#f0faf6":"#fdf5f4"):C.white, border:`1.5px solid ${s.checked?(ok?C.green:C.red):C.border}`, borderRadius:12, padding:"0.85rem 1rem", marginBottom:"0.6rem" }}>
        <div style={{ fontSize:"0.63rem", color:C.gray, textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>Câu {i+1} — Sắp xếp thành câu đúng</div>
        {/* Chosen area */}
        <div style={{ minHeight:40, display:"flex", flexWrap:"wrap", gap:"0.28rem", padding:"0.45rem 0.5rem", background:C.purpleL, borderRadius:8, marginBottom:"0.5rem" }}>
          {s.chosen.length===0&&<span style={{color:C.gray,fontSize:"0.75rem",alignSelf:"center"}}>Chọn từ bên dưới...</span>}
          {s.chosen.map((item,j)=><button key={item.id} onClick={()=>clickChosen(i,j)} disabled={s.checked}
            style={{padding:"0.25rem 0.55rem",border:`1.5px solid ${C.purple}`,borderRadius:6,background:C.white,color:C.purple,fontSize:"0.82rem",cursor:s.checked?"default":"pointer",fontFamily:"Georgia,serif"}}>{item.w}</button>)}
        </div>
        {/* Pool */}
        <div style={{ display:"flex", flexWrap:"wrap", gap:"0.28rem", marginBottom:"0.7rem" }}>
          {s.pool.map((item,j)=><button key={item.id} onClick={()=>clickPool(i,j)} disabled={s.checked}
            style={{padding:"0.25rem 0.55rem",border:`1.5px solid ${C.border}`,borderRadius:6,background:C.white,color:C.ink,fontSize:"0.82rem",cursor:s.checked?"default":"pointer",opacity:s.checked?0.4:1,fontFamily:"Georgia,serif"}}>{item.w}</button>)}
        </div>
        <div style={{ display:"flex", gap:"0.4rem" }}>
          {!s.checked&&s.chosen.length>0&&<button onClick={()=>check(i)} style={{padding:"0.3rem 0.8rem",border:"none",borderRadius:6,background:C.ink,color:C.white,fontSize:"0.75rem",cursor:"pointer"}}>Kiểm tra</button>}
          {!s.checked&&<button onClick={()=>reset(i)} style={{padding:"0.3rem 0.7rem",border:`1px solid ${C.border}`,borderRadius:6,background:C.white,color:C.gray,fontSize:"0.72rem",cursor:"pointer"}}>↺</button>}
        </div>
        {s.checked&&<div style={{marginTop:"0.45rem"}}>
          <div style={{fontSize:"0.78rem",color:ok?C.green:C.red,marginBottom:"0.2rem"}}>{ok?"✓ Chính xác!":<><span>✗ Đáp án: </span><b style={{fontFamily:"Georgia,serif"}}>{q.answer}</b></>}</div>
          {q.translation&&<div style={{fontSize:"0.72rem",color:C.gray}}>→ {q.translation}</div>}
          {q.explanation&&<div style={{fontSize:"0.72rem",color:C.gray,marginTop:"0.15rem"}}>💡 {q.explanation}</div>}
        </div>}
      </div>
    );
  })}</div>;
}

function GrammarPanel() {
  const [topic, setTopic] = useState("");
  const [level, setLevel] = useState("A1");
  const [gtype, setGtype] = useState("mixed");
  const [numQ, setNumQ] = useState(6);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState("");
  const [wrongCount, setWrongCount] = useState(0);

  const generate = async () => {
    if (!topic.trim()) { setErr("Nhập chủ đề ngữ pháp!"); return; }
    setLoading(true); setErr(""); setResult(null); setWrongCount(0);
    try { setResult(await callAI(buildGrammarPrompt(topic.trim(), level, gtype, numQ))); }
    catch(e) { setErr(e.message); }
    setLoading(false);
  };

  const GRAMMAR_BY_LEVEL = {
    A1: ["Động từ être & avoir","Mạo từ le/la/l'/les","Mạo từ un/une/des","Số đếm 0-100","Đại từ nhân xưng","Thì hiện tại (présent)","Phủ định ne...pas","Tính từ sở hữu","Giới từ à & de","Câu hỏi đơn giản"],
    A2: ["Thì quá khứ passé composé","Thì chưa hoàn thành imparfait","Động từ phản thân","Tính từ so sánh","Trạng từ thường gặp","Đại từ COD & COI","Giới từ chỉ nơi chốn","Mạo từ partitif du/de la","Tương lai gần futur proche","Câu mệnh lệnh impératif"],
    B1: ["Thì tương lai đơn futur simple","Điều kiện hiện tại conditionnel","Mệnh đề quan hệ qui/que","Câu bị động voix passive","Liên từ phức tạp","Đại từ y & en","Thì subjonctif cơ bản","So sánh nhất (superlatif)","Câu gián tiếp","Động từ khuyết thiếu devoir/pouvoir"],
    B2: ["Subjonctif nâng cao","Conditionnel passé","Plus-que-parfait","Câu điều kiện loại 2 & 3","Đảo ngữ trong câu hỏi","Mệnh đề phân từ (participe)","Câu nhượng bộ","Phủ định phức tạp ne...que","Gérondif","Câu cảm thán"],
    C1: ["Subjonctif passé","Đảo ngữ văn phong cao","Nominalisaton","Câu điều kiện hỗn hợp","Liên từ nối câu phức","Phong cách viết trang trọng","Passif với các thì phức","Vị từ tri giác","Câu giả định","Cohérence du discours"],
    C2: ["Văn phong văn học","Archaïsmes & néologismes","Nuances du subjonctif","Rhétorique & argumentation","Registres de langue","Ironie & implicite","Syntaxe complexe","Ellipse & anaphore","Figures de style","Cohésion textuelle"],
  };

  const suggestions = GRAMMAR_BY_LEVEL[level] || [];

  const renderExercises = () => {
    if (!result) return null;
    const onW = () => setWrongCount(n=>n+1);
    if (result.type==="mc") return <GrammarMC exercises={result.exercises} onWrong={onW}/>;
    if (result.type==="fill") return <GrammarFill exercises={result.exercises}/>;
    if (result.type==="order") return <GrammarOrder exercises={result.exercises}/>;
    if (result.type==="mixed") return result.sections?.map((sec,i)=>(
      <div key={i} style={{marginBottom:"0.5rem"}}>
        <SecLabel icon={sec.sectionType==="mc"?"☑":sec.sectionType==="fill"?"✏️":"🔀"} text={sec.sectionType==="mc"?"Chọn đáp án":sec.sectionType==="fill"?"Điền vào chỗ trống":"Sắp xếp câu"}/>
        {sec.sectionType==="mc"&&<GrammarMC exercises={sec.exercises} onWrong={onW}/>}
        {sec.sectionType==="fill"&&<GrammarFill exercises={sec.exercises}/>}
        {sec.sectionType==="order"&&<GrammarOrder exercises={sec.exercises}/>}
      </div>
    ));
    return null;
  };

  return (
    <div style={{padding:"1rem",display:"flex",flexDirection:"column",gap:"0.75rem"}}>
      {/* Input form */}
      <div style={{background:C.cream,borderRadius:12,padding:"0.9rem",display:"flex",flexDirection:"column",gap:"0.65rem"}}>
        <div style={{fontSize:"0.72rem",fontWeight:600,color:C.purple}}>🧩 Bài tập ngữ pháp</div>

        <div>
          <div style={{fontSize:"0.65rem",color:C.gray,marginBottom:"0.3rem"}}>Chủ đề ngữ pháp muốn ôn</div>
          <input value={topic} onChange={e=>setTopic(e.target.value)} onKeyDown={e=>e.key==="Enter"&&generate()}
            placeholder="vd: chia động từ, mạo từ, thì quá khứ..."
            style={{width:"100%",border:`1.5px solid ${C.border}`,borderRadius:8,padding:"0.5rem 0.7rem",fontSize:"0.82rem",fontFamily:"inherit",outline:"none",color:C.ink,boxSizing:"border-box"}}/>
        </div>

        {/* Quick suggestions by level */}
        <div>
          <div style={{fontSize:"0.63rem",color:C.gray,marginBottom:"0.3rem"}}>Gợi ý điểm ngữ pháp {level}:</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:"0.28rem"}}>
            {suggestions.map((s,i)=>(
              <button key={i} onClick={()=>setTopic(s)}
                style={{padding:"0.18rem 0.5rem",border:`1px solid ${topic===s?C.purple:C.border}`,borderRadius:20,background:topic===s?C.purple:C.white,color:topic===s?C.white:C.gray,fontSize:"0.65rem",cursor:"pointer",fontFamily:"inherit"}}>
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Level */}
        <div>
          <div style={{fontSize:"0.65rem",color:C.gray,marginBottom:"0.3rem"}}>Trình độ</div>
          <div style={{display:"flex",gap:"0.28rem"}}>
            {LEVELS.map(l=>(
              <button key={l} onClick={()=>{ setLevel(l); setTopic(""); }}
                style={{flex:1,padding:"0.35rem 0.2rem",border:`1.5px solid ${level===l?C.purple:C.border}`,borderRadius:7,background:level===l?C.purple:C.white,color:level===l?C.white:C.ink,fontSize:"0.72rem",cursor:"pointer",fontFamily:"inherit"}}>
                {l}
              </button>
            ))}
          </div>
        </div>

        {/* Type */}
        <div>
          <div style={{fontSize:"0.65rem",color:C.gray,marginBottom:"0.3rem"}}>Dạng bài tập</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0.28rem"}}>
            {GTYPES.map(t=>(
              <button key={t.id} onClick={()=>setGtype(t.id)}
                style={{padding:"0.4rem 0.3rem",border:`1.5px solid ${gtype===t.id?C.purple:C.border}`,borderRadius:8,background:gtype===t.id?C.purple:C.white,color:gtype===t.id?C.white:C.ink,fontSize:"0.73rem",cursor:"pointer",fontFamily:"inherit"}}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Num questions */}
        <div style={{display:"flex",alignItems:"center",gap:"0.5rem"}}>
          <span style={{fontSize:"0.65rem",color:C.gray,whiteSpace:"nowrap"}}>Số câu:</span>
          <input type="range" min={3} max={20} value={numQ} onChange={e=>setNumQ(Number(e.target.value))} style={{flex:1,accentColor:C.purple}}/>
          <span style={{fontFamily:"Georgia,serif",fontSize:"0.95rem",color:C.purple,fontWeight:600,minWidth:22}}>{numQ}</span>
        </div>

        {err&&<div style={{color:C.red,fontSize:"0.75rem",padding:"0.38rem 0.58rem",background:"#fde8e6",borderRadius:6}}>⚠ {err}</div>}

        <button onClick={generate} disabled={loading}
          style={{padding:"0.75rem",background:loading?C.gray:C.ink,color:C.paper,border:"none",borderRadius:8,fontFamily:"Georgia,serif",fontSize:"0.92rem",cursor:loading?"not-allowed":"pointer"}}>
          {loading?"Đang tạo bài tập...":"Tạo bài tập ✦"}
        </button>
      </div>

      {/* Grammar explanation banner */}
      {result?.explanation && (
        <div style={{background:C.purpleL,border:`1px solid #d4c5f5`,borderRadius:10,padding:"0.7rem 0.9rem"}}>
          <div style={{fontSize:"0.65rem",textTransform:"uppercase",letterSpacing:1,color:C.purple,marginBottom:"0.3rem",fontWeight:600}}>📖 Lý thuyết — {result.topic} · {result.level}</div>
          <div style={{fontSize:"0.8rem",color:C.ink,lineHeight:1.7}}>{result.explanation}</div>
        </div>
      )}

      {/* Exercises */}
      {loading&&(
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:160,gap:"0.7rem",color:C.gray}}>
          <Spinner/><span style={{fontSize:"0.83rem"}}>AI đang tạo bài tập...</span>
        </div>
      )}
      {!loading&&result&&(
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"0.75rem"}}>
            <span style={{background:C.purple,color:C.white,fontSize:"0.6rem",padding:"0.16rem 0.52rem",borderRadius:20,textTransform:"uppercase",letterSpacing:0.5}}>{result.topic} · {result.level}</span>
            <button onClick={generate} style={{padding:"0.23rem 0.6rem",border:`1.5px solid ${C.border}`,borderRadius:20,background:C.white,color:C.ink,fontSize:"0.68rem",cursor:"pointer",fontFamily:"inherit"}}>🔄 Tạo lại</button>
          </div>
          {renderExercises()}
        </div>
      )}
    </div>
  );
}

// ── Vocab Generator ────────────────────────────────────────
function VocabGenerator({ onGenerate }) {
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [count, setCount] = useState(10);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const generate = async () => {
    if (!topic.trim()) { setErr("Nhập chủ đề trước!"); return; }
    setLoading(true); setErr("");
    try {
      const result = await callAI(
        `French teacher. Generate ${count} French vocabulary words for the topic: "${topic}".
For each word include:
- fr: the masculine form (or base form for verbs/expressions)
- fr_f: the feminine form if it exists and differs from masculine (e.g. for professions: "le médecin" → "la médecin", "le boulanger" → "la boulangère"). Leave empty string if no feminine form or if identical.
- gender: grammatical gender label like "m.", "f.", "m./f.", "m. pl." etc. Use "m./f." when the word has both forms.
- vi: Vietnamese meaning
- example_fr: one natural example sentence in French
- example_vi: Vietnamese translation of the example

Return ONLY JSON: {"words":[{"fr":"French word","fr_f":"feminine form or empty","gender":"m.","vi":"Vietnamese meaning","example_fr":"Example sentence","example_vi":"Vietnamese translation"}]}`
      );
      if (!result.words?.length) throw new Error("Không có kết quả");
      onGenerate(result.words);
    } catch(e) { setErr(e.message); }
    setLoading(false);
  };

  return (
    <div style={{ background:C.white, border:`1.5px solid ${C.purple}44`, borderRadius:12, overflow:"hidden" }}>
      <button onClick={()=>setOpen(o=>!o)}
        style={{ width:"100%", display:"flex", justifyContent:"space-between", alignItems:"center", padding:"0.65rem 0.9rem", background:"transparent", border:"none", cursor:"pointer", fontFamily:"inherit" }}>
        <div style={{ display:"flex", alignItems:"center", gap:"0.5rem" }}>
          <span style={{ fontSize:"0.85rem" }}>✨</span>
          <span style={{ fontSize:"0.78rem", fontWeight:600, color:C.purple }}>Gợi ý từ theo chủ đề</span>
        </div>
        <span style={{ fontSize:"0.8rem", color:C.gray }}>{open?"▲":"▼"}</span>
      </button>
      {open && (
        <div style={{ padding:"0.75rem 0.9rem", borderTop:`1px solid ${C.border}`, display:"flex", flexDirection:"column", gap:"0.6rem" }}>
          <div style={{ display:"flex", gap:"0.5rem" }}>
            <input value={topic} onChange={e=>setTopic(e.target.value)} onKeyDown={e=>e.key==="Enter"&&generate()}
              placeholder="Chủ đề (vd: nghề nghiệp, đồ ăn, du lịch...)"
              style={{ flex:1, border:`1.5px solid ${C.border}`, borderRadius:8, padding:"0.42rem 0.65rem", fontSize:"0.8rem", fontFamily:"inherit", outline:"none", color:C.ink }} />
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:"0.6rem" }}>
            <span style={{ fontSize:"0.72rem", color:C.gray, whiteSpace:"nowrap" }}>Số từ:</span>
            <input type="range" min={5} max={30} value={count} onChange={e=>setCount(Number(e.target.value))}
              style={{ flex:1, accentColor:C.purple }} />
            <span style={{ fontFamily:"Georgia,serif", fontSize:"0.95rem", color:C.purple, fontWeight:600, minWidth:24 }}>{count}</span>
          </div>
          {err && <div style={{ fontSize:"0.72rem", color:C.red }}>{err}</div>}
          <button onClick={generate} disabled={loading}
            style={{ padding:"0.5rem", background:loading?C.gray:C.purple, color:C.white, border:"none", borderRadius:8, fontSize:"0.82rem", cursor:loading?"not-allowed":"pointer", fontFamily:"Georgia,serif" }}>
            {loading?"Đang tạo...":"Tạo từ vựng ✦"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── API Key Screen ──────────────────────────────────────────
function ApiKeyScreen({ onSave }) {
  const [val, setVal] = useState(localStorage.getItem("api_key") || "");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const save = () => {
    if (!val.trim().startsWith("sk-ant-")) { setErr("API key phải bắt đầu bằng sk-ant-..."); return; }
    setApiKey(val.trim()); onSave(val.trim());
  };
  return (
    <div style={{ minHeight:"100vh", background:C.ink, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"2rem 1.5rem" }}>
      <div style={{ fontFamily:"Georgia,serif", fontSize:"2.2rem", color:C.paper, marginBottom:"0.4rem" }}>Français</div>
      <div style={{ width:36, height:2, background:C.gold, marginBottom:"1.6rem" }} />
      <div style={{ background:"#ffffff0d", border:`1px solid ${C.gold}33`, borderRadius:16, padding:"1.8rem 1.5rem", width:"100%", maxWidth:400 }}>
        <div style={{ fontFamily:"Georgia,serif", color:C.gold, fontSize:"1rem", marginBottom:"0.4rem" }}>🔑 Nhập Anthropic API Key</div>
        <div style={{ fontSize:"0.75rem", color:"#a0a0b8", lineHeight:1.6, marginBottom:"1.2rem" }}>
          Lấy API key tại{" "}
          <a href="https://console.anthropic.com/keys" target="_blank" rel="noreferrer" style={{ color:C.gold }}>console.anthropic.com</a>
          <br/>Key được lưu trong trình duyệt của bạn, không gửi đi đâu khác.
        </div>
        <div style={{ position:"relative", marginBottom:"0.8rem" }}>
          <input
            type={show ? "text" : "password"}
            value={val}
            onChange={e => { setVal(e.target.value); setErr(""); }}
            onKeyDown={e => e.key === "Enter" && save()}
            placeholder="sk-ant-api03-..."
            style={{ width:"100%", boxSizing:"border-box", padding:"0.6rem 2.6rem 0.6rem 0.8rem", border:`1.5px solid ${err?C.red:C.border}`, borderRadius:8, background:"#ffffff0d", color:C.paper, fontSize:"0.82rem", fontFamily:"monospace", outline:"none" }}
          />
          <button onClick={() => setShow(s=>!s)} style={{ position:"absolute", right:8, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", color:C.gray, cursor:"pointer", fontSize:"0.9rem" }}>{show?"🙈":"👁"}</button>
        </div>
        {err && <div style={{ fontSize:"0.72rem", color:C.red, marginBottom:"0.6rem" }}>{err}</div>}
        <button onClick={save} style={{ width:"100%", padding:"0.75rem", background:C.gold, color:C.ink, border:"none", borderRadius:8, fontFamily:"Georgia,serif", fontSize:"0.92rem", cursor:"pointer", fontWeight:600 }}>
          Bắt đầu học ✦
        </button>
      </div>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────
export default function App() {
  const [apiKey, setApiKeyState] = useState(() => localStorage.getItem("api_key") || "");

  const handleApiKeySave = (k) => { setApiKeyState(k); };

  if (!apiKey) return <ApiKeyScreen onSave={handleApiKeySave} />;

  return <AppInner apiKey={apiKey} onChangeKey={() => { localStorage.removeItem("api_key"); _apiKey = ""; setApiKeyState(""); }} />;
}

function AppInner({ apiKey, onChangeKey }) {
  // init global key
  useEffect(() => { _apiKey = apiKey; }, [apiKey]);
  const [text, setText] = useState(DEFAULTS);
  const [type, setType] = useState("multiple_choice");
  const [numQ, setNumQ] = useState(8);
  const [quiz, setQuiz] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [view, setView] = useState("input");
  const [sets, setSets] = useState([]);
  const [stats, setStats] = useState({});
  const [showSave, setShowSave] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [toast, setToast] = useState("");
  const [generatedVocab, setGeneratedVocab] = useState([]);

  const words = parseWords(text);

  useEffect(() => { loadSets().then(setSets); }, []);

  const showToast = msg => { setToast(msg); setTimeout(()=>setToast(""),2200); };

  const [wrongAnswers, setWrongAnswers] = useState([]); // [{question, answer, ...}]

  const recordAnswer = useCallback((word, isOk) => {
    setStats(prev => {
      const e = prev[word]||{ok:0,wrong:0};
      return { ...prev, [word]:{ ok:e.ok+(isOk?1:0), wrong:e.wrong+(isOk?0:1) } };
    });
  }, []);

  // Track wrong MC/Fill answers for "retry wrong" feature
  const recordWrong = useCallback((q) => {
    setWrongAnswers(prev => {
      const exists = prev.find(x => x.question===q.question);
      return exists ? prev : [...prev, q];
    });
  }, []);

  const addMoreQuestions = async () => {
    if (!quiz || CLIENT_TYPES.includes(type)) return;
    setLoading(true);
    try {
      const more = await callAI(buildPrompt(quiz.type, words, 5));
      if (quiz.type==="multiple_choice") setQuiz(q=>({...q, questions:[...q.questions,...(more.questions||[])]}));
      else if (quiz.type==="fill_blank") setQuiz(q=>({...q, questions:[...q.questions,...(more.questions||[])]}));
      else if (quiz.type==="mixed") setQuiz(q=>({...q, sections: q.sections.map(sec=>{
        const newSec = more.sections?.find(s=>s.sectionType===sec.sectionType);
        if (!newSec || sec.sectionType==="matching") return sec;
        return {...sec, questions:[...sec.questions,...(newSec.questions||[])]};
      })}));
      showToast("✓ Đã thêm câu hỏi!");
    } catch(e) { showToast("⚠ "+e.message); }
    setLoading(false);
  };

  const retryWrong = async () => {
    if (wrongAnswers.length===0) { showToast("Chưa có câu sai!"); return; }
    setLoading(true);
    try {
      // Extract wrong words and build new quiz targeting them
      const wrongWords = wrongAnswers.map(q => {
        // Try to find the word from the question text or answer
        const found = words.find(w => q.question?.includes(w.fr) || q.question?.includes(w.vi) || q.answer?.includes(w.fr));
        return found || { fr: q.answer||"", vi:"" };
      }).filter(w=>w.fr);
      const targetWords = wrongWords.length>=2 ? wrongWords : words;
      const newQuiz = await callAI(buildPrompt(quiz.type==="matching"?"multiple_choice":quiz.type, targetWords, Math.max(wrongAnswers.length, 3)));
      setQuiz(newQuiz);
      setWrongAnswers([]);
      showToast(`✓ Ôn lại ${wrongAnswers.length} câu sai!`);
    } catch(e) { showToast("⚠ "+e.message); }
    setLoading(false);
  };

  const CLIENT_TYPES = ["dictee","flashcard","anagramme"];

  const generate = useCallback(async () => {
    if (words.length < 2) { setError("Cần ít nhất 2 từ!"); return; }
    if (CLIENT_TYPES.includes(type)) { setQuiz({ type, words }); setView("quiz"); return; }
    if (words.length < 3) { setError("Cần ít nhất 3 từ!"); return; }
    setLoading(true); setError(null); setQuiz(null); setView("quiz");
    try { setQuiz(await callAIBatched(type, words, numQ)); }
    catch(e) { setError(e.message); setView("input"); }
    setLoading(false);
  }, [words, type, numQ]);

  const handleSave = async name => {
    const newSet = { id: Date.now(), name, text, count: words.length, date: new Date().toLocaleDateString("vi-VN") };
    const updated = [newSet, ...sets];
    setSets(updated); await saveSets(updated);
    setShowSave(false); showToast("✓ Đã lưu bộ từ!");
  };

  function renderQuiz() {
    if (!quiz) return null;
    if (quiz.type==="multiple_choice") return <MCSection questions={quiz.questions} onRecord={recordAnswer} onWrong={recordWrong} />;
    if (quiz.type==="fill_blank") return <FillSection questions={quiz.questions} onRecord={recordAnswer} onWrong={recordWrong} />;
    if (quiz.type==="matching") return <MatchSection pairs={quiz.pairs} />;
    if (quiz.type==="dictee") return <DicteeSection words={quiz.words} onRecord={recordAnswer} />;
    if (quiz.type==="flashcard") return <FlashcardSection words={quiz.words} onRecord={recordAnswer} />;
    if (quiz.type==="anagramme") return <AnagrammeSection words={quiz.words} onRecord={recordAnswer} />;
    if (quiz.type==="mixed") return quiz.sections.map((sec,i)=>(
      <div key={i}>
        {sec.sectionType==="multiple_choice"&&<MCSection questions={sec.questions} sl onRecord={recordAnswer} onWrong={recordWrong}/>}
        {sec.sectionType==="fill_blank"&&<FillSection questions={sec.questions} sl onRecord={recordAnswer} onWrong={recordWrong}/>}
        {sec.sectionType==="matching"&&<MatchSection pairs={sec.pairs} sl/>}
      </div>
    ));
    return null;
  }

  const TYPE_NAMES = { multiple_choice:"Trắc nghiệm", fill_blank:"Điền từ", matching:"Nối từ", dictee:"Dictée", flashcard:"Flashcard", anagramme:"Anagramme", mixed:"Hỗn hợp" };
  const hasFill = quiz && (quiz.type==="fill_blank"||(quiz.type==="mixed"&&quiz.sections?.some(s=>s.sectionType==="fill_blank")));
  const [section, setSection] = useState("home"); // home | vocab | grammar

  const navBtn = (label, target, show=true) => show && (
    <button onClick={()=>setView(target)}
      style={{ padding:"0.22rem 0.58rem", background:view===target?C.gold:"transparent", border:`1px solid ${C.gold}`, color:view===target?C.ink:C.gold, borderRadius:20, fontSize:"0.63rem", cursor:"pointer", fontWeight:view===target?600:400, whiteSpace:"nowrap" }}>
      {label}
    </button>
  );

  return (
    <div style={{ fontFamily:"system-ui,sans-serif", background:C.paper, minHeight:"100vh", color:C.ink }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}`}</style>

      {/* Toast */}
      {toast && <div style={{ position:"fixed", top:16, left:"50%", transform:"translateX(-50%)", background:C.ink, color:C.paper, padding:"0.5rem 1rem", borderRadius:20, fontSize:"0.8rem", zIndex:200, whiteSpace:"nowrap" }}>{toast}</div>}

      {/* Modals */}
      {showSave && <SaveModal text={text} onSave={handleSave} onClose={()=>setShowSave(false)} />}
      {showImport && <ImportModal onImport={t=>{setText(t);showToast("✓ Import thành công!");}} onClose={()=>setShowImport(false)} />}

      {/* ── HOMEPAGE ── */}
      {section==="home" && (
        <div style={{ minHeight:"100vh", display:"flex", flexDirection:"column", background:C.ink }}>
          {/* Hero */}
          <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"3rem 1.5rem 2rem", textAlign:"center" }}>
            <div style={{ fontSize:"0.72rem", color:C.gold, letterSpacing:"0.2em", textTransform:"uppercase", marginBottom:"0.8rem", animation:"fadeUp 0.5s ease" }}>Bienvenue</div>
            <div style={{ fontFamily:"Georgia,serif", fontSize:"2.8rem", color:C.paper, lineHeight:1.1, marginBottom:"0.5rem", animation:"fadeUp 0.5s ease 0.1s both" }}>Français</div>
            <div style={{ width:40, height:2, background:C.gold, margin:"0.8rem auto", animation:"fadeUp 0.5s ease 0.2s both" }} />
            <div style={{ fontSize:"0.85rem", color:"#a0a0b8", lineHeight:1.7, maxWidth:280, animation:"fadeUp 0.5s ease 0.3s both" }}>
              Học tiếng Pháp hiệu quả<br/>với trợ lý AI cá nhân
            </div>
            <button onClick={onChangeKey} style={{ marginTop:"1.2rem", background:"transparent", border:`1px solid ${C.gold}44`, color:"#a0a0b8", borderRadius:20, padding:"0.22rem 0.8rem", fontSize:"0.65rem", cursor:"pointer" }}>🔑 Đổi API key</button>
          </div>

          {/* 2 big cards */}
          <div style={{ padding:"0 1.25rem 3rem", display:"flex", flexDirection:"column", gap:"0.85rem", animation:"fadeUp 0.5s ease 0.35s both" }}>
            {/* Vocabulaire */}
            <button onClick={()=>{ setSection("vocab"); setView("input"); }}
              style={{ background:"transparent", border:`1.5px solid ${C.gold}44`, borderRadius:16, padding:"1.5rem", textAlign:"left", cursor:"pointer", fontFamily:"inherit", position:"relative", overflow:"hidden", transition:"all 0.2s" }}
              onMouseEnter={e=>e.currentTarget.style.background="#ffffff11"}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                <div>
                  <div style={{ fontSize:"0.65rem", color:C.gold, letterSpacing:"0.15em", textTransform:"uppercase", marginBottom:"0.4rem" }}>Module 01</div>
                  <div style={{ fontFamily:"Georgia,serif", fontSize:"1.6rem", color:C.paper, marginBottom:"0.4rem" }}>Le Vocabulaire</div>
                  <div style={{ fontSize:"0.78rem", color:"#a0a0b8", lineHeight:1.6 }}>Từ vựng · Flashcard · Dictée<br/>Anagramme · Nối từ</div>
                </div>
                <div style={{ fontSize:"2rem", opacity:0.6 }}>📚</div>
              </div>
              <div style={{ marginTop:"1rem", display:"flex", gap:"0.4rem", flexWrap:"wrap" }}>
                {["Trắc nghiệm","Điền từ","Dictée","Flashcard","Anagramme"].map((t,i)=>(
                  <span key={i} style={{ padding:"0.18rem 0.55rem", border:`1px solid ${C.gold}44`, borderRadius:20, fontSize:"0.65rem", color:C.gold }}>{t}</span>
                ))}
              </div>
            </button>

            {/* Grammaire */}
            <button onClick={()=>{ setSection("grammar"); setView("grammar"); }}
              style={{ background:"transparent", border:`1.5px solid ${C.purple}66`, borderRadius:16, padding:"1.5rem", textAlign:"left", cursor:"pointer", fontFamily:"inherit", transition:"all 0.2s" }}
              onMouseEnter={e=>e.currentTarget.style.background="#6b4fbb11"}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                <div>
                  <div style={{ fontSize:"0.65rem", color:C.purpleL, letterSpacing:"0.15em", textTransform:"uppercase", marginBottom:"0.4rem" }}>Module 02</div>
                  <div style={{ fontFamily:"Georgia,serif", fontSize:"1.6rem", color:C.paper, marginBottom:"0.4rem" }}>La Grammaire</div>
                  <div style={{ fontSize:"0.78rem", color:"#a0a0b8", lineHeight:1.6 }}>Chọn đáp án · Điền chỗ trống<br/>Sắp xếp câu · A1 → C2</div>
                </div>
                <div style={{ fontSize:"2rem", opacity:0.6 }}>🧩</div>
              </div>
              <div style={{ marginTop:"1rem", display:"flex", gap:"0.4rem", flexWrap:"wrap" }}>
                {["A1","A2","B1","B2","C1","C2"].map((l,i)=>(
                  <span key={i} style={{ padding:"0.18rem 0.55rem", border:`1px solid ${C.purple}66`, borderRadius:20, fontSize:"0.65rem", color:C.purpleL }}>{l}</span>
                ))}
              </div>
            </button>

            {/* Conversation */}
            <button onClick={()=>{ setSection("conversation"); setView("conversation"); }}
              style={{ background:"transparent", border:`1.5px solid #2980b966`, borderRadius:16, padding:"1.5rem", textAlign:"left", cursor:"pointer", fontFamily:"inherit", transition:"all 0.2s" }}
              onMouseEnter={e=>e.currentTarget.style.background="#2980b911"}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                <div>
                  <div style={{ fontSize:"0.65rem", color:"#7ab8e8", letterSpacing:"0.15em", textTransform:"uppercase", marginBottom:"0.4rem" }}>Module 04</div>
                  <div style={{ fontFamily:"Georgia,serif", fontSize:"1.6rem", color:C.paper, marginBottom:"0.4rem" }}>La Conversation</div>
                  <div style={{ fontSize:"0.78rem", color:"#a0a0b8", lineHeight:1.6 }}>Roleplay theo chủ đề Edito A1<br/>AI sửa lỗi · Phát âm tích hợp</div>
                </div>
                <div style={{ fontSize:"2rem", opacity:0.6 }}>💬</div>
              </div>
              <div style={{ marginTop:"1rem", display:"flex", gap:"0.4rem", flexWrap:"wrap" }}>
                {["Chào hỏi","Mua sắm","Quán cà phê","Hỏi đường","Gia đình"].map((t,i)=>(
                  <span key={i} style={{ padding:"0.18rem 0.55rem", border:`1px solid #2980b944`, borderRadius:20, fontSize:"0.65rem", color:"#7ab8e8" }}>{t}</span>
                ))}
              </div>
            </button>

            {/* Writing */}
            <button onClick={()=>{ setSection("writing"); setView("writing"); }}
              style={{ background:"transparent", border:`1.5px solid #e67e2266`, borderRadius:16, padding:"1.5rem", textAlign:"left", cursor:"pointer", fontFamily:"inherit", transition:"all 0.2s" }}
              onMouseEnter={e=>e.currentTarget.style.background="#e67e2211"}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                <div>
                  <div style={{ fontSize:"0.65rem", color:"#f0a070", letterSpacing:"0.15em", textTransform:"uppercase", marginBottom:"0.4rem" }}>Module 05</div>
                  <div style={{ fontFamily:"Georgia,serif", fontSize:"1.6rem", color:C.paper, marginBottom:"0.4rem" }}>L'Écriture</div>
                  <div style={{ fontSize:"0.78rem", color:"#a0a0b8", lineHeight:1.6 }}>Viết câu tự do · AI chấm điểm<br/>Phân tích lỗi chi tiết bằng tiếng Việt</div>
                </div>
                <div style={{ fontSize:"2rem", opacity:0.6 }}>✍️</div>
              </div>
              <div style={{ marginTop:"1rem", display:"flex", gap:"0.4rem", flexWrap:"wrap" }}>
                {["Chấm điểm","Sửa lỗi","Ngữ pháp","Từ vựng","Chính tả"].map((t,i)=>(
                  <span key={i} style={{ padding:"0.18rem 0.55rem", border:`1px solid #e67e2244`, borderRadius:20, fontSize:"0.65rem", color:"#f0a070" }}>{t}</span>
                ))}
              </div>
            </button>

            {/* Weak Spots */}
            <button onClick={()=>{ setSection("weakspots"); setView("weakspots"); }}
              style={{ background:"transparent", border:`1.5px solid ${C.red}66`, borderRadius:16, padding:"1.5rem", textAlign:"left", cursor:"pointer", fontFamily:"inherit", transition:"all 0.2s" }}
              onMouseEnter={e=>e.currentTarget.style.background="#c0392b11"}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                <div>
                  <div style={{ fontSize:"0.65rem", color:"#e88", letterSpacing:"0.15em", textTransform:"uppercase", marginBottom:"0.4rem" }}>Module 06</div>
                  <div style={{ fontFamily:"Georgia,serif", fontSize:"1.6rem", color:C.paper, marginBottom:"0.4rem" }}>Les Points Faibles</div>
                  <div style={{ fontSize:"0.78rem", color:"#a0a0b8", lineHeight:1.6 }}>Phân tích lỗi hay gặp<br/>Bài tập trúng điểm yếu của bạn</div>
                </div>
                <div style={{ fontSize:"2rem", opacity:0.6 }}>🎯</div>
              </div>
              <div style={{ marginTop:"1rem", display:"flex", gap:"0.4rem", flexWrap:"wrap" }}>
                {["Mạo từ","Giới từ","Chia động từ","Phủ định","Câu hỏi"].map((t,i)=>(
                  <span key={i} style={{ padding:"0.18rem 0.55rem", border:`1px solid ${C.red}44`, borderRadius:20, fontSize:"0.65rem", color:"#e88" }}>{t}</span>
                ))}
              </div>
            </button>

            {/* Analyse */}
            <button onClick={()=>{ setSection("analyse"); setView("analyse"); }}
              style={{ background:"transparent", border:`1.5px solid ${C.green}66`, borderRadius:16, padding:"1.5rem", textAlign:"left", cursor:"pointer", fontFamily:"inherit", transition:"all 0.2s" }}
              onMouseEnter={e=>e.currentTarget.style.background="#3d8b6f11"}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                <div>
                  <div style={{ fontSize:"0.65rem", color:"#7ec8a8", letterSpacing:"0.15em", textTransform:"uppercase", marginBottom:"0.4rem" }}>Module 03</div>
                  <div style={{ fontFamily:"Georgia,serif", fontSize:"1.6rem", color:C.paper, marginBottom:"0.4rem" }}>L'Analyse</div>
                  <div style={{ fontSize:"0.78rem", color:"#a0a0b8", lineHeight:1.6 }}>Upload văn bản · Ảnh · PDF<br/>Phân tích từ vựng & ngữ pháp</div>
                </div>
                <div style={{ fontSize:"2rem", opacity:0.6 }}>🔍</div>
              </div>
              <div style={{ marginTop:"1rem", display:"flex", gap:"0.4rem", flexWrap:"wrap" }}>
                {["Từ vựng","Ngữ pháp","Bản dịch","Điểm lưu ý"].map((t,i)=>(
                  <span key={i} style={{ padding:"0.18rem 0.55rem", border:`1px solid ${C.green}44`, borderRadius:20, fontSize:"0.65rem", color:"#7ec8a8" }}>{t}</span>
                ))}
              </div>
            </button>
          </div>
        </div>
      )}

      {/* ── APP SHELL (vocab + grammar sections) ── */}
      {section!=="home" && (<>
      {/* Header */}
      <div style={{ background:C.ink, color:C.paper, padding:"0.8rem 1rem", display:"flex", alignItems:"center", gap:"0.45rem", borderBottom:`3px solid ${C.gold}`, flexWrap:"wrap" }}>
        <button onClick={()=>setSection("home")} style={{ background:"transparent", border:"none", color:C.gold, cursor:"pointer", fontSize:"0.75rem", padding:"0.1rem 0.3rem", marginRight:"0.2rem" }}>←</button>
        <span style={{ fontFamily:"Georgia,serif", fontSize:"1.1rem", marginRight:"auto" }}>
          {section==="vocab" ? "Le Vocabulaire" : section==="grammar" ? "La Grammaire" : section==="conversation" ? "La Conversation" : section==="writing" ? "L'Écriture" : section==="weakspots" ? "Les Points Faibles" : "L'Analyse"}
        </span>

        {section==="vocab" && <>
          {navBtn("✏️ Nhập","input")}
          {navBtn("📂 Lịch sử","history")}
          {navBtn("📊 Thống kê","stats")}
          {navBtn("📋 Bảng từ","vocab-table", generatedVocab.length>0)}
          {navBtn("💬 Ví dụ","examples", words.length>0)}
          {navBtn("📋 Bài tập","quiz", !!(quiz||loading))}
        </>}

        {section==="grammar" && <>
          {navBtn("🧩 Bài tập","grammar")}
        </>}

        {section==="writing" && <>
          {navBtn("✍️ Viết câu","writing")}
        </>}

        {section==="weakspots" && <>
          {navBtn("🎯 Điểm yếu","weakspots")}
        </>}

        {section==="conversation" && <>
          {navBtn("💬 Hội thoại","conversation")}
        </>}

        {section==="analyse" && <>
          {navBtn("🔍 Phân tích","analyse")}
        </>}
      </div>

      {/* ── INPUT ── */}
      {view==="input" && (
        <div style={{ background:C.cream, padding:"1rem", display:"flex", flexDirection:"column", gap:"0.72rem" }}>

          {/* Vocab Generator */}
          <VocabGenerator onGenerate={generated => {
            const lines = generated.map(w => `${w.fr} — ${w.vi}`).join("\n");
            setText(lines);
            setView("vocab-table");
            setGeneratedVocab(generated);
          }} />

          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div style={{ fontSize:"0.72rem", fontWeight:600, color:C.purple }}>📝 Nhập từ vựng</div>
            <div style={{ display:"flex", gap:"0.4rem" }}>
              <button onClick={()=>setShowImport(true)} style={{ padding:"0.22rem 0.6rem", background:"transparent", border:`1px solid ${C.border}`, color:C.gray, borderRadius:20, fontSize:"0.65rem", cursor:"pointer" }}>📁 Import</button>
              {words.length>=3 && <button onClick={()=>setShowSave(true)} style={{ padding:"0.22rem 0.6rem", background:"transparent", border:`1px solid ${C.purple}`, color:C.purple, borderRadius:20, fontSize:"0.65rem", cursor:"pointer" }}>💾 Lưu</button>}
            </div>
          </div>
          <textarea value={text} onChange={e=>setText(e.target.value)}
            placeholder={"la boulangerie — tiệm bánh mì\nle marché — chợ\n..."}
            style={{ width:"100%", height:145, border:`1.5px solid ${C.border}`, borderRadius:8, padding:"0.58rem", fontFamily:"inherit", fontSize:"0.8rem", background:C.white, resize:"vertical", color:C.ink, lineHeight:1.6, outline:"none", boxSizing:"border-box" }} />
          <div style={{ fontSize:"0.65rem", color:C.gray }}>
            Mỗi dòng: <code style={{ background:C.border, padding:"1px 4px", borderRadius:3 }}>từ pháp — nghĩa</code>
            {words.length>0 && <span style={{ color:C.purple, marginLeft:6 }}>{words.length} từ</span>}
          </div>
          {words.length>0 && <div style={{ display:"flex", flexWrap:"wrap", gap:"0.25rem" }}>
            {words.slice(0,8).map((w,i)=><span key={i} style={{ background:C.white, border:`1px solid ${C.border}`, borderRadius:20, padding:"0.09rem 0.44rem", fontSize:"0.66rem", color:C.purple }}>{w.fr}</span>)}
            {words.length>8 && <span style={{ background:C.white, border:`1px solid ${C.border}`, borderRadius:20, padding:"0.09rem 0.44rem", fontSize:"0.66rem", color:C.gray }}>+{words.length-8}</span>}
          </div>}

          {/* Type selector */}
          <div>
            <div style={{ fontSize:"0.72rem", fontWeight:600, color:C.purple, marginBottom:"0.35rem" }}>🎯 Dạng bài tập</div>
            <div style={{ fontSize:"0.63rem", color:C.gray, textTransform:"uppercase", letterSpacing:1, marginBottom:"0.28rem" }}>Chọn đáp án</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0.28rem", marginBottom:"0.5rem" }}>
              {[{id:"multiple_choice",label:"☑ Trắc nghiệm"},{id:"matching",label:"🔗 Nối từ"},{id:"flashcard",label:"🃏 Flashcard"},{id:"mixed",label:"🎲 Hỗn hợp"}].map(t=>(
                <button key={t.id} onClick={()=>setType(t.id)} style={{ padding:"0.42rem 0.3rem", border:`1.5px solid ${type===t.id?C.purple:C.border}`, borderRadius:8, background:type===t.id?C.purple:C.white, color:type===t.id?C.white:C.ink, fontSize:"0.75rem", cursor:"pointer", fontFamily:"inherit", transition:"all 0.15s" }}>{t.label}</button>
              ))}
            </div>
            <div style={{ fontSize:"0.63rem", color:C.gray, textTransform:"uppercase", letterSpacing:1, marginBottom:"0.28rem" }}>Điền / Viết từ</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"0.28rem" }}>
              {[{id:"fill_blank",label:"✏️ Điền từ"},{id:"dictee",label:"🎧 Dictée"},{id:"anagramme",label:"🔀 Anagramme"}].map(t=>(
                <button key={t.id} onClick={()=>setType(t.id)} style={{ padding:"0.42rem 0.3rem", border:`1.5px solid ${type===t.id?C.purple:C.border}`, borderRadius:8, background:type===t.id?C.purple:C.white, color:type===t.id?C.white:C.ink, fontSize:"0.75rem", cursor:"pointer", fontFamily:"inherit", transition:"all 0.15s" }}>{t.label}</button>
              ))}
            </div>
          </div>

          {/* numQ slider */}
          {!["matching","dictee","flashcard","anagramme"].includes(type) && (
            <div>
              <div style={{ fontSize:"0.72rem", fontWeight:600, color:C.purple, marginBottom:"0.35rem" }}>🔢 Số câu hỏi</div>
              <div style={{ display:"flex", alignItems:"center", gap:"0.5rem" }}>
                <input type="range" min={3} max={30} value={numQ} onChange={e=>setNumQ(Number(e.target.value))} style={{ flex:1, accentColor:C.purple }} />
                <div style={{ minWidth:32, textAlign:"center", fontFamily:"Georgia,serif", fontSize:"1rem", color:C.purple, fontWeight:600 }}>{numQ}</div>
              </div>
              {numQ>words.length && words.length>0 && <div style={{ fontSize:"0.65rem", color:C.gold, marginTop:"0.2rem" }}>💡 AI sẽ dùng lại từ theo nhiều cách</div>}
            </div>
          )}

          {error && <div style={{ color:C.red, fontSize:"0.75rem", padding:"0.38rem 0.58rem", background:"#fde8e6", borderRadius:6 }}>⚠ {error}</div>}
          <button onClick={generate} disabled={loading||words.length<2}
            style={{ width:"100%", padding:"0.78rem", background:words.length<2?C.gray:C.ink, color:C.paper, border:"none", borderRadius:8, fontFamily:"Georgia,serif", fontSize:"0.93rem", cursor:words.length<2?"not-allowed":"pointer", letterSpacing:0.3 }}>
            {loading?"Đang tạo...":"Tạo bài tập ✦"}
          </button>
        </div>
      )}

      {/* ── HISTORY ── */}
      {view==="history" && (
        <div style={{ padding:"1rem" }}>
          <div style={{ fontSize:"0.72rem", fontWeight:600, color:C.purple, marginBottom:"0.7rem" }}>📂 Bộ từ đã lưu</div>
          {sets.length===0
            ? <div style={{ textAlign:"center", color:C.gray, fontSize:"0.85rem", padding:"2rem", lineHeight:1.8 }}>Chưa có bộ từ nào.<br/>Nhập từ vựng và nhấn 💾 Lưu!</div>
            : sets.map(s=>(
              <div key={s.id} style={{ background:C.white, border:`1.5px solid ${C.border}`, borderRadius:12, padding:"0.8rem 1rem", marginBottom:"0.55rem" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                  <div>
                    <div style={{ fontFamily:"Georgia,serif", fontSize:"0.95rem", color:C.ink, marginBottom:"0.2rem" }}>{s.name}</div>
                    <div style={{ fontSize:"0.7rem", color:C.gray }}>{s.count} từ · {s.date}</div>
                  </div>
                  <div style={{ display:"flex", gap:"0.35rem" }}>
                    <button onClick={()=>{setText(s.text);setView("input");showToast("✓ Đã load!");}}
                      style={{ padding:"0.25rem 0.65rem", background:C.purple, color:C.white, border:"none", borderRadius:6, fontSize:"0.7rem", cursor:"pointer" }}>Ôn lại</button>
                    <button onClick={async()=>{const u=sets.filter(x=>x.id!==s.id);setSets(u);await saveSets(u);}}
                      style={{ padding:"0.25rem 0.5rem", background:"transparent", color:C.gray, border:`1px solid ${C.border}`, borderRadius:6, fontSize:"0.7rem", cursor:"pointer" }}>🗑</button>
                  </div>
                </div>
              </div>
            ))
          }
        </div>
      )}

      {/* ── STATS ── */}
      {view==="stats" && (() => {
        const entries = Object.entries(stats)
          .map(([word,s])=>({ word, ...s, total:s.ok+s.wrong, rate:s.ok+s.wrong>0?Math.round(s.ok/(s.ok+s.wrong)*100):0 }))
          .sort((a,b)=>a.rate-b.rate);
        const weak = entries.filter(e=>e.rate<80);
        const mastered = entries.filter(e=>e.rate>=80);
        const weakWords = weak.map(e=>{ const w=words.find(x=>x.fr===e.word); return w?`${w.fr}${w.vi?" — "+w.vi:""}`:e.word; });

        const WordPill = ({ e, isWeak }) => {
          const vi = words.find(w=>w.fr===e.word)?.vi||"";
          return (
            <div style={{ background:C.white, border:`1px solid ${isWeak?C.red+"44":C.border}`, borderRadius:8, padding:"0.45rem 0.6rem", marginBottom:"0.35rem" }}>
              <div style={{ fontFamily:"Georgia,serif", fontSize:"0.82rem" }}>{e.word}</div>
              {vi && <div style={{ fontSize:"0.63rem", color:C.gray, marginTop:"0.04rem" }}>{vi}</div>}
              <div style={{ display:"flex", gap:"0.4rem", alignItems:"center", marginTop:"0.28rem" }}>
                <div style={{ flex:1, height:3, background:C.border, borderRadius:2 }}>
                  <div style={{ height:"100%", width:`${e.rate}%`, background:isWeak?(e.rate>=50?C.gold:C.red):C.green, borderRadius:2 }} />
                </div>
                <span style={{ fontSize:"0.62rem", color:isWeak?C.red:C.green, fontWeight:600, minWidth:28 }}>{e.rate}%</span>
              </div>
            </div>
          );
        };

        return (
          <div style={{ padding:"1rem" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.75rem" }}>
              <div style={{ fontSize:"0.72rem", fontWeight:600, color:C.purple }}>📊 Thống kê</div>
              <div style={{ display:"flex", gap:"0.4rem" }}>
                {weakWords.length>0 && <button onClick={()=>{setText(weakWords.join("\n"));setQuiz(null);setView("input");showToast("✓ Đã load từ yếu!");}} style={{ padding:"0.22rem 0.65rem", background:C.purple, color:C.white, border:"none", borderRadius:20, fontSize:"0.65rem", cursor:"pointer" }}>🎯 Ôn từ yếu ({weak.length})</button>}
                {entries.length>0 && <button onClick={()=>{setStats({});showToast("✓ Đã xóa");}} style={{ padding:"0.22rem 0.55rem", background:"transparent", color:C.gray, border:`1px solid ${C.border}`, borderRadius:20, fontSize:"0.65rem", cursor:"pointer" }}>🗑</button>}
              </div>
            </div>
            {entries.length===0
              ? <div style={{ textAlign:"center", color:C.gray, fontSize:"0.85rem", padding:"3rem 1rem", lineHeight:1.8 }}>Chưa có dữ liệu.<br/>Làm bài tập để bắt đầu theo dõi!</div>
              : <>
                  <div style={{ display:"flex", gap:"0.5rem", marginBottom:"0.85rem" }}>
                    {[{label:"Tổng từ",val:entries.length,color:C.purple},{label:"Từ yếu",val:weak.length,color:C.red},{label:"Thành thạo",val:mastered.length,color:C.green}].map((item,i)=>(
                      <div key={i} style={{ flex:1, background:C.white, border:`1.5px solid ${C.border}`, borderRadius:10, padding:"0.5rem 0.3rem", textAlign:"center" }}>
                        <div style={{ fontFamily:"Georgia,serif", fontSize:"1.2rem", color:item.color, fontWeight:600 }}>{item.val}</div>
                        <div style={{ fontSize:"0.6rem", color:C.gray }}>{item.label}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0.75rem" }}>
                    <div>
                      <div style={{ fontSize:"0.63rem", textTransform:"uppercase", letterSpacing:1, color:C.red, marginBottom:"0.4rem", fontWeight:600 }}>✗ Từ yếu ({weak.length})</div>
                      {weak.length===0?<div style={{ fontSize:"0.75rem", color:C.gray, fontStyle:"italic" }}>Không có 🎉</div>:weak.map((e,i)=><WordPill key={i} e={e} isWeak={true}/>)}
                    </div>
                    <div>
                      <div style={{ fontSize:"0.63rem", textTransform:"uppercase", letterSpacing:1, color:C.green, marginBottom:"0.4rem", fontWeight:600 }}>✓ Thành thạo ({mastered.length})</div>
                      {mastered.length===0?<div style={{ fontSize:"0.75rem", color:C.gray, fontStyle:"italic" }}>Chưa có</div>:mastered.map((e,i)=><WordPill key={i} e={e} isWeak={false}/>)}
                    </div>
                  </div>
                </>
            }
          </div>
        );
      })()}

      {/* ── GRAMMAR ── */}
      {view==="grammar" && <GrammarPanel />}

      {/* ── ANALYSE ── */}
      {view==="analyse" && <AnalysePanel />}

      {/* ── VOCAB TABLE ── */}
      {view==="vocab-table" && generatedVocab.length>0 && (
        <div style={{ padding:"1rem" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.8rem" }}>
            <div style={{ fontFamily:"Georgia,serif", fontSize:"1rem", color:C.purple }}>
              ✨ {generatedVocab.length} từ vựng
            </div>
            <div style={{ display:"flex", gap:"0.4rem" }}>
              <button onClick={()=>setView("input")}
                style={{ padding:"0.22rem 0.65rem", background:C.purple, color:C.white, border:"none", borderRadius:20, fontSize:"0.65rem", cursor:"pointer" }}>
                📝 Luyện tập →
              </button>
            </div>
          </div>

          {/* Table header */}
          <div style={{ display:"grid", gridTemplateColumns:"1.2fr 1fr 0.8fr 1.6fr", gap:"0.3rem", marginBottom:"0.3rem", padding:"0.4rem 0.6rem" }}>
            {["Giống đực","Giống cái","Nghĩa","Ví dụ"].map((h,i)=>(
              <div key={i} style={{ fontSize:"0.6rem", textTransform:"uppercase", letterSpacing:1, color:C.gray, fontWeight:600 }}>{h}</div>
            ))}
          </div>

          {generatedVocab.map((w, i) => (
            <div key={i} style={{ display:"grid", gridTemplateColumns:"1.2fr 1fr 0.8fr 1.6fr", gap:"0.3rem", background:i%2===0?C.white:C.cream, borderRadius:8, padding:"0.55rem 0.6rem", marginBottom:"0.25rem", alignItems:"start" }}>
              {/* Masculine */}
              <div>
                <div style={{ fontFamily:"Georgia,serif", fontSize:"0.88rem", color:C.ink, fontWeight:600, display:"flex", alignItems:"center", gap:"0.2rem" }}>{w.fr} <SpeakBtn text={w.fr} /></div>
                {w.gender && <div style={{ fontSize:"0.65rem", color:C.purple, fontStyle:"italic", marginTop:"0.05rem" }}>{w.gender}</div>}
              </div>
              {/* Feminine */}
              <div>
                {w.fr_f
                  ? <><div style={{ fontFamily:"Georgia,serif", fontSize:"0.88rem", color:C.purple }}>{w.fr_f}</div>
                      <div style={{ fontSize:"0.65rem", color:C.purple, fontStyle:"italic", marginTop:"0.05rem" }}>f.</div></>
                  : <div style={{ fontSize:"0.72rem", color:C.border, fontStyle:"italic" }}>—</div>
                }
              </div>
              {/* Meaning */}
              <div style={{ fontSize:"0.78rem", color:C.ink }}>{w.vi}</div>
              {/* Example */}
              <div>
                <div style={{ fontSize:"0.75rem", color:C.ink, fontStyle:"italic", lineHeight:1.4 }}>{w.example_fr}</div>
                <div style={{ fontSize:"0.68rem", color:C.gray, marginTop:"0.15rem" }}>→ {w.example_vi}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── EXAMPLES ── */}
      {view==="examples" && (
        <div style={{ padding:"1rem" }}>
          <div style={{ fontSize:"0.72rem", fontWeight:600, color:C.purple, marginBottom:"0.7rem" }}>💬 Tạo câu ví dụ & phân tích</div>
          {words.map((w,i)=><ExampleCard key={i} word={w}/>)}
        </div>
      )}

      {/* ── QUIZ ── */}
      {view==="quiz" && (
        <div style={{ padding:"1rem" }}>
          {loading
            ? <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:200, gap:"0.7rem", color:C.gray }}><Spinner/><span style={{ fontSize:"0.83rem" }}>AI đang tạo bài tập...</span></div>
            : quiz
              ? <>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.8rem", flexWrap:"wrap", gap:"0.4rem" }}>
                    <span style={{ background:C.purple, color:C.white, fontSize:"0.6rem", padding:"0.16rem 0.52rem", borderRadius:20, textTransform:"uppercase", letterSpacing:0.5 }}>{TYPE_NAMES[quiz.type]||quiz.type}</span>
                    <div style={{ display:"flex", gap:"0.4rem", flexWrap:"wrap" }}>
                      {hasFill && <button onClick={()=>exportFillPDF(quiz)} style={{ padding:"0.23rem 0.6rem", border:`1.5px solid ${C.purple}`, borderRadius:20, background:C.white, color:C.purple, fontSize:"0.68rem", cursor:"pointer", fontFamily:"inherit" }}>📄 PDF</button>}
                      {!CLIENT_TYPES.includes(quiz.type) && (
                        <button onClick={addMoreQuestions} disabled={loading} style={{ padding:"0.23rem 0.6rem", border:`1.5px solid ${C.green}`, borderRadius:20, background:C.white, color:C.green, fontSize:"0.68rem", cursor:"pointer", fontFamily:"inherit" }}>➕ Thêm câu</button>
                      )}
                      {wrongAnswers.length>0 && !CLIENT_TYPES.includes(quiz.type) && (
                        <button onClick={retryWrong} disabled={loading} style={{ padding:"0.23rem 0.6rem", border:`1.5px solid ${C.red}`, borderRadius:20, background:C.white, color:C.red, fontSize:"0.68rem", cursor:"pointer", fontFamily:"inherit" }}>🔁 Ôn sai ({wrongAnswers.length})</button>
                      )}
                      <button onClick={()=>{setWrongAnswers([]);generate();}} style={{ padding:"0.23rem 0.6rem", border:`1.5px solid ${C.border}`, borderRadius:20, background:C.white, color:C.ink, fontSize:"0.68rem", cursor:"pointer", fontFamily:"inherit" }}>🔄 Tạo lại</button>
                    </div>
                  </div>
                  {renderQuiz()}
                </>
              : null
          }
        </div>
      )}
      {/* ── WRITING ── */}
      {view==="writing" && <WritingPanel />}

      {/* ── WEAK SPOTS ── */}
      {view==="weakspots" && <WeakSpotsPanel />}

      {/* ── CONVERSATION ── */}
      {view==="conversation" && <ConversationPanel />}

      </>)}
    </div>
  );
}
