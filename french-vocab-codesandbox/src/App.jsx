import { useState, useCallback, useEffect, useRef } from "react";

const C = {
  ink:"#1a1a2e", paper:"#f5f6fa", cream:"#f0f1f8",
  purple:"#5b4fcf", purpleL:"#ede9ff",
  gold:"#f59e0b", green:"#10b981", red:"#ef4444",
  gray:"#6b7280", border:"#e5e7eb", white:"#ffffff",
  g1:"rgba(255,255,255,1)",
  g2:"rgba(255,255,255,0.85)",
  g3:"rgba(245,246,250,0.95)",
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
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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
  // Shuffle and split words into two halves so each batch covers different vocabulary
  const shuffled = shuffleArray(words);
  const mid = Math.ceil(shuffled.length / 2);
  const words1 = shuffled.length >= 4 ? shuffled.slice(0, mid) : shuffled;
  const words2 = shuffled.length >= 4 ? shuffled.slice(mid) : shuffled;
  const [r1, r2] = await Promise.all([callAI(buildPrompt(type, words1, h1)), callAI(buildPrompt(type, words2, h2))]);
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
  // Shuffle first, then sample only as many words as needed (avoids AI always picking from the top of the list)
  const shuffled = shuffleArray(words);
  const sampled = n <= shuffled.length ? shuffled.slice(0, Math.min(n + Math.ceil(n * 0.3), shuffled.length)) : shuffled;
  const list = sampled.map(w => w.vi ? `${w.fr} — ${w.vi}` : w.fr).join("\n");
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
        {!done && <button onClick={()=>setDone(true)} style={{padding:"0.3rem 0.65rem",background:C.purple,color:C.white,border:"none",borderRadius:6,fontSize:"0.73rem",cursor:"pointer"}}>Kiểm tra</button>}
        {done && <span style={{fontSize:"0.73rem",color:ok?C.green:C.red,fontWeight:500}}>{ok?"✓ Đúng!":`✗ Đáp án: ${ex.answer}`}</span>}
      </div>
      {done && ex.explanation && <div style={{ marginTop:"0.3rem", fontSize:"0.73rem", color:C.gray }}>💡 {ex.explanation}</div>}
    </div>
  );
}

// ── Conjugaison Panel ──────────────────────────────────────
const TENSES = [
  { id:"présent",         label:"Présent",          desc:"Hiện tại" },
  { id:"passé composé",   label:"Passé composé",    desc:"Quá khứ hoàn thành" },
  { id:"imparfait",       label:"Imparfait",         desc:"Quá khứ chưa hoàn thành" },
  { id:"futur proche",    label:"Futur proche",      desc:"Tương lai gần" },
  { id:"futur simple",    label:"Futur simple",      desc:"Tương lai đơn" },
  { id:"conditionnel",    label:"Conditionnel",      desc:"Điều kiện" },
  { id:"subjonctif",      label:"Subjonctif",        desc:"Giả định" },
  { id:"impératif",       label:"Impératif",         desc:"Mệnh lệnh" },
];

const PRONOUNS = ["je","tu","il/elle","nous","vous","ils/elles"];
const QUICK_VERBS = ["être","avoir","aller","faire","venir","pouvoir","vouloir","prendre","partir","manger","parler","finir","voir","savoir","mettre"];

function ConjugaisonPanel() {
  const [verb, setVerb] = useState("");
  const [tenses, setTenses] = useState(["présent","passé composé","futur proche"]);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [quizMode, setQuizMode] = useState(false);
  const [quiz, setQuiz] = useState(null);
  const [quizLoading, setQuizLoading] = useState(false);

  const toggleTense = t => setTenses(prev => prev.includes(t) ? prev.filter(x=>x!==t) : [...prev, t]);

  const lookup = async (v) => {
    const target = v || verb;
    if (!target.trim()) return;
    setLoading(true); setErr(""); setResult(null); setQuiz(null); setQuizMode(false);
    try {
      const r = await callAI(`You are a French grammar expert. Conjugate the verb "${target.trim()}" for these tenses: ${tenses.join(", ")}.
Return ONLY JSON:
{
  "verb": "infinitive",
  "meaning": "Vietnamese meaning",
  "group": "1er groupe|2e groupe|3e groupe|irrégulier",
  "auxiliary": "avoir|être",
  "tenses": [
    {
      "tense": "tense name",
      "tense_vi": "Vietnamese tense name",
      "usage": "one-line usage tip in Vietnamese",
      "forms": [
        {"pronoun":"je","form":"conjugated form","example":"short example sentence"}
      ]
    }
  ]
}`);
      setResult(r);
    } catch(e) { setErr(e.message); }
    setLoading(false);
  };

  const generateQuiz = async () => {
    if (!result) return;
    setQuizLoading(true); setQuiz(null);
    try {
      const r = await callAI(`French teacher. Create 8 fill-in-the-blank conjugation exercises for the verb "${result.verb}" using these tenses: ${tenses.join(", ")}.
Return ONLY JSON:
{"questions":[{"sentence":"French sentence with ___ for the verb form","answer":"correct conjugated form","pronoun":"the pronoun used","tense":"tense name","hint":"Vietnamese hint about the tense"}]}`);
      setQuiz(r);
    } catch(e) { setErr(e.message); }
    setQuizLoading(false);
  };

  const groupColor = g => ({"1er groupe":C.green,"2e groupe":C.purple,"3e groupe":C.gold,"irrégulier":C.red}[g]||C.gray);

  return (
    <div style={{ padding:"1rem", display:"flex", flexDirection:"column", gap:"0.85rem" }}>
      <div style={{ fontSize:"0.72rem", fontWeight:600, color:"#16a085" }}>📖 Conjugaison</div>
      <div style={{ fontSize:"0.73rem", color:C.gray, lineHeight:1.6 }}>Nhập một động từ — xem bảng chia đầy đủ và luyện tập ngay.</div>

      {/* Input */}
      <div style={{ background:C.white, border:`1.5px solid ${C.border}`, borderRadius:12, padding:"0.85rem", display:"flex", flexDirection:"column", gap:"0.65rem" }}>
        <div style={{ display:"flex", gap:"0.5rem" }}>
          <input value={verb} onChange={e=>setVerb(e.target.value)} onKeyDown={e=>e.key==="Enter"&&lookup()}
            placeholder="Nhập động từ... vd: manger"
            style={{ flex:1, border:`1.5px solid ${C.border}`, borderRadius:8, padding:"0.5rem 0.75rem", fontSize:"0.88rem", fontFamily:"Georgia,serif", outline:"none", color:C.ink }} />
          <button onClick={()=>lookup()} disabled={loading||!verb.trim()}
            style={{ padding:"0.5rem 0.9rem", background: verb.trim()?"#16a085":C.border, color:C.white, border:"none", borderRadius:8, fontSize:"0.82rem", cursor: verb.trim()?"pointer":"default", fontFamily:"Georgia,serif" }}>
            {loading?"...":"Xem ✦"}
          </button>
        </div>

        {/* Quick verb chips */}
        <div>
          <div style={{ fontSize:"0.62rem", color:C.gray, textTransform:"uppercase", letterSpacing:1, marginBottom:"0.3rem" }}>Động từ thông dụng</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:"0.28rem" }}>
            {QUICK_VERBS.map(v => (
              <button key={v} onClick={()=>{ setVerb(v); lookup(v); }}
                style={{ padding:"0.18rem 0.55rem", border:`1px solid ${C.border}`, borderRadius:20, background: verb===v?C.purple:C.white, color: verb===v?C.white:C.gray, fontSize:"0.72rem", cursor:"pointer", fontFamily:"Georgia,serif" }}>
                {v}
              </button>
            ))}
          </div>
        </div>

        {/* Tense selector */}
        <div>
          <div style={{ fontSize:"0.62rem", color:C.gray, textTransform:"uppercase", letterSpacing:1, marginBottom:"0.3rem" }}>Thì muốn xem</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0.28rem" }}>
            {TENSES.map(t => (
              <button key={t.id} onClick={()=>toggleTense(t.id)}
                style={{ padding:"0.35rem 0.5rem", border:`1.5px solid ${tenses.includes(t.id)?"#16a085":C.border}`, borderRadius:8, background: tenses.includes(t.id)?"#e8f8f5":C.white, color: tenses.includes(t.id)?"#16a085":C.ink, fontSize:"0.72rem", cursor:"pointer", fontFamily:"inherit", textAlign:"left" }}>
                <div style={{ fontWeight: tenses.includes(t.id)?600:400 }}>{t.label}</div>
                <div style={{ fontSize:"0.6rem", color: tenses.includes(t.id)?"#16a085":C.gray }}>{t.desc}</div>
              </button>
            ))}
          </div>
        </div>
        {err && <div style={{ fontSize:"0.72rem", color:C.red }}>⚠ {err}</div>}
      </div>

      {loading && <div style={{ display:"flex", justifyContent:"center", padding:"1.5rem" }}><Spinner /></div>}

      {/* Result */}
      {result && !quizMode && (
        <div style={{ display:"flex", flexDirection:"column", gap:"0.65rem", animation:"fadeUp 0.3s ease" }}>
          {/* Verb header */}
          <div style={{ background:C.purple, borderRadius:12, padding:"0.9rem 1rem", display:"flex", alignItems:"center", gap:"0.8rem" }}>
            <div>
              <div style={{ fontFamily:"Georgia,serif", fontSize:"1.6rem", color:C.paper }}>{result.verb} <SpeakBtn text={result.verb} size="1rem" /></div>
              <div style={{ fontSize:"0.78rem", color:"#a0a0b8", marginTop:"0.15rem" }}>{result.meaning}</div>
            </div>
            <div style={{ marginLeft:"auto", display:"flex", flexDirection:"column", alignItems:"flex-end", gap:"0.3rem" }}>
              <span style={{ background:`${groupColor(result.group)}33`, color:groupColor(result.group), fontSize:"0.65rem", padding:"0.15rem 0.5rem", borderRadius:20, fontWeight:600 }}>{result.group}</span>
              {result.auxiliary && <span style={{ background:"#ffffff11", color:"#a0a0b8", fontSize:"0.65rem", padding:"0.15rem 0.5rem", borderRadius:20 }}>aux. {result.auxiliary}</span>}
            </div>
          </div>

          {/* Conjugation tables */}
          {result.tenses?.map((t, ti) => (
            <div key={ti} style={{ background:C.white, border:`1.5px solid ${C.border}`, borderRadius:12, overflow:"hidden" }}>
              <div style={{ background:"#e8f8f5", borderBottom:`1px solid ${C.border}`, padding:"0.6rem 0.9rem", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div>
                  <span style={{ fontFamily:"Georgia,serif", fontSize:"0.92rem", color:"#16a085", fontWeight:600 }}>{t.tense}</span>
                  <span style={{ fontSize:"0.72rem", color:C.gray, marginLeft:"0.5rem" }}>— {t.tense_vi}</span>
                </div>
              </div>
              {t.usage && <div style={{ padding:"0.4rem 0.9rem", fontSize:"0.72rem", color:C.gold, background:"#fff8e6", borderBottom:`1px solid ${C.border}` }}>💡 {t.usage}</div>}
              <div style={{ padding:"0.5rem" }}>
                {t.forms?.map((f, fi) => (
                  <div key={fi} style={{ display:"grid", gridTemplateColumns:"80px 1fr", gap:"0.5rem", padding:"0.42rem 0.4rem", background: fi%2===0?C.white:C.cream, borderRadius:6, alignItems:"start" }}>
                    <div style={{ fontSize:"0.78rem", color:C.gray, fontWeight:600 }}>{f.pronoun}</div>
                    <div>
                      <div style={{ display:"flex", alignItems:"center", gap:"0.3rem" }}>
                        <span style={{ fontFamily:"Georgia,serif", fontSize:"0.95rem", color:C.purple, fontWeight:600 }}>{f.form}</span>
                        <SpeakBtn text={`${f.pronoun === "il/elle" ? "il" : f.pronoun === "ils/elles" ? "ils" : f.pronoun} ${f.form}`} size="0.75rem" />
                      </div>
                      {f.example && <div style={{ fontSize:"0.7rem", color:C.gray, fontStyle:"italic", marginTop:"0.1rem" }}>{f.example}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Quiz button */}
          <button onClick={()=>{ setQuizMode(true); generateQuiz(); }}
            style={{ padding:"0.7rem", background:"#16a085", color:C.white, border:"none", borderRadius:8, fontFamily:"Georgia,serif", fontSize:"0.88rem", cursor:"pointer" }}>
            🧩 Luyện chia động từ này
          </button>
        </div>
      )}

      {/* Quiz mode */}
      {quizMode && (
        <div style={{ display:"flex", flexDirection:"column", gap:"0.65rem" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div style={{ fontFamily:"Georgia,serif", color:"#16a085", fontSize:"0.92rem" }}>🧩 Luyện tập — {result?.verb}</div>
            <button onClick={()=>setQuizMode(false)} style={{ background:"transparent", border:`1px solid ${C.border}`, borderRadius:20, padding:"0.2rem 0.6rem", fontSize:"0.68rem", color:C.gray, cursor:"pointer" }}>← Bảng chia</button>
          </div>
          {quizLoading && <div style={{ display:"flex", justifyContent:"center", padding:"1rem" }}><Spinner /></div>}
          {quiz?.questions?.map((q, i) => <ConjugQuizItem key={i} q={q} idx={i} />)}
          {quiz && <button onClick={generateQuiz} style={{ padding:"0.55rem", background:"transparent", border:`1px solid ${C.border}`, borderRadius:8, color:C.gray, fontSize:"0.78rem", cursor:"pointer" }}>🔄 Tạo bài mới</button>}
        </div>
      )}
    </div>
  );
}

function ConjugQuizItem({ q, idx }) {
  const [val, setVal] = useState("");
  const [done, setDone] = useState(false);
  const ok = done && val.trim().toLowerCase() === (q.answer||"").toLowerCase();
  return (
    <div style={{ background:C.white, border:`1.5px solid ${done?(ok?C.green:C.red):C.border}`, borderRadius:10, padding:"0.75rem 0.9rem" }}>
      <div style={{ fontSize:"0.63rem", color:C.gray, textTransform:"uppercase", letterSpacing:1, marginBottom:"0.35rem" }}>
        Câu {idx+1} · <span style={{ color:"#16a085" }}>{q.tense}</span> · {q.pronoun}
      </div>
      <div style={{ fontFamily:"Georgia,serif", fontSize:"0.9rem", marginBottom:"0.5rem", lineHeight:1.5, color:C.ink }}>{q.sentence}</div>
      {q.hint && <div style={{ fontSize:"0.7rem", color:C.gold, marginBottom:"0.4rem" }}>💡 {q.hint}</div>}
      <div style={{ display:"flex", gap:"0.38rem", alignItems:"center" }}>
        <input value={val} disabled={done} onChange={e=>setVal(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!done&&setDone(true)}
          placeholder={`${q.pronoun} ___`}
          style={{ border:`1.5px solid ${done?(ok?C.green:C.red):C.border}`, borderRadius:6, padding:"0.3rem 0.6rem", fontSize:"0.88rem", fontFamily:"Georgia,serif", width:160, background:done?(ok?"#e8f7f1":"#fde8e6"):C.white, color:done?(ok?C.green:C.red):C.ink, outline:"none" }} />
        {!done && <button onClick={()=>setDone(true)} style={{ padding:"0.3rem 0.65rem", background:C.purple, color:C.white, border:"none", borderRadius:6, fontSize:"0.73rem", cursor:"pointer" }}>Kiểm tra</button>}
        {done && <span style={{ fontSize:"0.73rem", color:ok?C.green:C.red, fontWeight:500 }}>{ok ? "✓ Đúng!" : `✗ Đáp án: ${q.answer}`}</span>}
        {done && !ok && <SpeakBtn text={q.answer} />}
      </div>
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
              {!done && <button onClick={() => doCheck(i,q,v)} style={{ padding:"0.3rem 0.65rem", background:C.purple, color:C.white, border:"none", borderRadius:6, fontSize:"0.73rem", cursor:"pointer", fontFamily:"inherit" }}>Kiểm tra</button>}
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
      {done===pairs.length && <div style={{ background:C.green, color:C.white, borderRadius:10, padding:"0.55rem 0.9rem", marginBottom:"0.5rem", textAlign:"center", fontSize:"0.82rem" }}>🎉 Hoàn thành! Nối đúng tất cả {pairs.length} cặp</div>}
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
            <button onClick={check} style={{ padding:"0.3rem 0.8rem", border:"none", borderRadius:6, background:C.purple, color:C.white, fontSize:"0.72rem", cursor:"pointer" }}>Kiểm tra</button>
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
          <div style={{ marginTop:"0.8rem" }}><button onClick={check} style={{ padding:"0.35rem 1rem", border:"none", borderRadius:6, background:C.purple, color:C.white, fontSize:"0.78rem", cursor:"pointer" }}>Kiểm tra</button></div>
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
          {!checked && tiles.length===0 && <button onClick={check} style={{ padding:"0.38rem 1.2rem", border:"none", borderRadius:6, background:C.purple, color:C.white, fontSize:"0.78rem", cursor:"pointer" }}>Kiểm tra</button>}
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
  // explanationRules: array of {type, content} where type = "rule"|"warning"|"note"
  // This structured format allows the UI to render each rule on its own line with proper styling.
  const explSchema = `"explanationRules":[{"type":"rule","content":"Quy tắc 1 — giải thích ngắn gọn tiếng Việt"},{"type":"rule","content":"Quy tắc 2 — ..."},{"type":"warning","content":"⚠️ Lưu ý quan trọng"},{"type":"note","content":"Ngoại lệ hoặc mẹo nhớ"}]`;
  if (gtype === "mc") return `${base}\nReturn ONLY JSON: {"type":"mc","topic":"${topic}","level":"${level}",${explSchema},"exercises":[{"question":"Full sentence with context","options":["option1","option2","option3","option4"],"answer":"correct option","explanation":"why this is correct in Vietnamese"}]}`;
  if (gtype === "fill") return `${base}\nReturn ONLY JSON: {"type":"fill","topic":"${topic}","level":"${level}",${explSchema},"exercises":[{"sentence":"French sentence with ___ for the blank","answer":"correct word/form","hint":"brief Vietnamese hint","explanation":"why this form is correct in Vietnamese"}]}`;
  if (gtype === "order") return `${base} Create sentences where words are scrambled.\nIMPORTANT: The "words" array must NOT contain punctuation (no periods, commas, question marks). Punctuation goes only in "answer".\nReturn ONLY JSON: {"type":"order","topic":"${topic}","level":"${level}",${explSchema},"exercises":[{"words":["word1","word2","word3","word4","word5"],"answer":"Correct sentence (may include punctuation)","translation":"Vietnamese translation","explanation":"note about word order in Vietnamese"}]}`;
  if (gtype === "mixed") return `${base} Create a mix: ${Math.ceil(n/3)} multiple choice + ${Math.ceil(n/3)} fill-in-blank + ${Math.floor(n/3)} word order.\nFor word order exercises: "words" array must NOT contain punctuation.\nReturn ONLY JSON: {"type":"mixed","topic":"${topic}","level":"${level}",${explSchema},"sections":[{"sectionType":"mc","exercises":[{"question":"...","options":["a","b","c","d"],"answer":"correct","explanation":"Vietnamese why"}]},{"sectionType":"fill","exercises":[{"sentence":"sentence with ___","answer":"word","hint":"hint","explanation":"Vietnamese why"}]},{"sectionType":"order","exercises":[{"words":["w1","w2","w3"],"answer":"Correct sentence","translation":"Vietnamese","explanation":"note"}]}`;
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
          {!done&&<button onClick={()=>setChk(x=>({...x,[i]:true}))} style={{padding:"0.3rem 0.65rem",background:C.purple,color:C.white,border:"none",borderRadius:6,fontSize:"0.73rem",cursor:"pointer",fontFamily:"inherit"}}>Kiểm tra</button>}
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
          {!s.checked&&s.chosen.length>0&&<button onClick={()=>check(i)} style={{padding:"0.3rem 0.8rem",border:"none",borderRadius:6,background:C.purple,color:C.white,fontSize:"0.75rem",cursor:"pointer"}}>Kiểm tra</button>}
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

// ── Édito Grammar Presets ──────────────────────────────────
const EDITO_GRAMMAR = [
  {
    id:"g0", num:"0", title:"Bienvenue !", points:[
      {
        topic:"Động từ ÊTRE — Chia ở thì hiện tại",
        rule:`ÊTRE = "là / là / thì / ở" — động từ quan trọng nhất tiếng Pháp!

Bảng chia:
• Je suis       → Tôi là / tôi ở
• Tu es         → Bạn là / bạn ở (thân mật)
• Il/Elle est   → Anh ấy / Cô ấy là
• Nous sommes   → Chúng tôi là
• Vous êtes     → Các bạn là / Bạn là (lịch sự)
• Ils/Elles sont → Họ là

⚠️ Être là động từ BẤT QUY TẮC — phải học thuộc lòng!

Dùng être để:
✅ Nói quốc tịch: Je suis vietnamien.
✅ Nói nghề nghiệp: Elle est médecin.
✅ Miêu tả tính cách: Il est sympa.
✅ Nói nơi ở: Nous sommes à Paris.`,
        examples:[
          "Je suis étudiant(e). — Tôi là sinh viên.",
          "Tu es français? — Bạn là người Pháp à?",
          "Il est très sympa. — Anh ấy rất dễ mến.",
          "Nous sommes à Hanoi. — Chúng tôi ở Hà Nội.",
          "Vous êtes professeur? — Thầy/Cô là giáo viên ạ?",
          "Elles sont belles. — Chúng thật đẹp.",
        ]
      },
      {
        topic:"Động từ AVOIR — Chia ở thì hiện tại",
        rule:`AVOIR = "có" — cũng là động từ bất quy tắc, rất hay dùng!

Bảng chia:
• J'ai         → Tôi có  (j' vì bắt đầu bằng nguyên âm)
• Tu as        → Bạn có
• Il/Elle a    → Anh ấy / Cô ấy có
• Nous avons   → Chúng tôi có
• Vous avez    → Các bạn có / Bạn có (lịch sự)
• Ils/Elles ont → Họ có

Dùng avoir để:
✅ Nói tuổi (quan trọng!): J'ai 20 ans. (KHÔNG nói "Je suis 20 ans")
✅ Nói có/sở hữu: Tu as une voiture?
✅ Diễn đạt cảm giác thể chất: Il a faim (đói), il a soif (khát), il a froid (lạnh)

⚠️ Lỗi thường gặp: Nói tuổi dùng AVOIR, không dùng être!
❌ Je suis 25 ans.   ✅ J'ai 25 ans.`,
        examples:[
          "J'ai 22 ans. — Tôi 22 tuổi.",
          "Tu as un stylo? — Bạn có cây bút không?",
          "Elle a une sœur. — Cô ấy có một người chị.",
          "Nous avons un cours à 9h. — Chúng tôi có lớp lúc 9 giờ.",
          "Vous avez faim? — Bạn đói không?",
          "Ils ont deux enfants. — Họ có hai đứa con.",
        ]
      },
      {
        topic:"Đại từ nhân xưng — Je, Tu, Il, Elle, Nous, Vous, Ils, Elles",
        rule:`Trong tiếng Pháp, ĐẠI TỪ NHÂN XƯNG luôn phải có trước động từ!

• Je (Tôi) → J' trước nguyên âm: j'aime, j'ai
• Tu (Bạn) → dùng với người thân, bạn bè, trẻ em
• Il (Anh ấy / Nó - nam)
• Elle (Cô ấy / Nó - nữ)
• On (Người ta / Chúng ta - thân mật) → chia như il/elle
• Nous (Chúng tôi / Chúng ta - trang trọng hơn on)
• Vous (Các bạn / Bạn lịch sự với 1 người)
• Ils (Họ - nhóm có ít nhất 1 nam)
• Elles (Họ - nhóm toàn nữ)

💡 Mẹo: Vous dùng với 1 người khi lịch sự (thầy cô, người lạ) — gọi là "vouvoyer"
💡 On thay cho nous trong khẩu ngữ: On va au café? = Nous allons au café?

Dạng nhấn mạnh (pronoms toniques):
Je→Moi, Tu→Toi, Il→Lui, Elle→Elle, Nous→Nous, Vous→Vous, Ils→Eux, Elles→Elles`,
        examples:[
          "Je m'appelle Linh. — Tôi tên là Linh.",
          "Tu habites où? — Bạn sống ở đâu?",
          "On mange ensemble? — Chúng mình ăn cùng nhau nhé?",
          "Vous avez quel âge, madame? — Bà bao nhiêu tuổi ạ?",
          "Ils sont étudiants. — Họ là sinh viên.",
          "Moi, j'adore le café! — Còn tôi, tôi rất thích cà phê!",
        ]
      },
      {
        topic:"Số đếm 0–31 và Ngày tháng",
        rule:`SỐ ĐẾM CƠ BẢN (0–20):
0 zéro, 1 un/une, 2 deux, 3 trois, 4 quatre, 5 cinq,
6 six, 7 sept, 8 huit, 9 neuf, 10 dix,
11 onze, 12 douze, 13 treize, 14 quatorze, 15 quinze,
16 seize, 17 dix-sept, 18 dix-huit, 19 dix-neuf, 20 vingt

SỐ 21–31:
21 vingt et un, 22 vingt-deux, ... 31 trente et un
(Chú ý: 21, 31, 41... dùng "et un"; 22, 32... dùng gạch ngang)

NGÀY TRONG TUẦN: lundi, mardi, mercredi, jeudi, vendredi, samedi, dimanche
💡 Thứ Hai trong tiếng Pháp là lundi (không phải Chủ Nhật!)

THÁNG TRONG NĂM: janvier, février, mars, avril, mai, juin,
juillet, août, septembre, octobre, novembre, décembre

NÓI NGÀY THÁNG: le + số + tháng
⚠️ Ngày 1 nói "le premier" (không phải "le un")`,
        examples:[
          "Aujourd'hui c'est le premier mai. — Hôm nay là mùng 1 tháng 5.",
          "Je suis né(e) le 15 août. — Tôi sinh ngày 15 tháng 8.",
          "Le cours est le lundi et le mercredi. — Lớp học vào thứ Hai và thứ Tư.",
          "Mon numéro c'est le 06 12 34 56 78. — Số của tôi là...",
          "On est le combien aujourd'hui? — Hôm nay là ngày mấy?",
        ]
      },
    ]
  },
  {
    id:"g1", num:"1", title:"Je suis…", points:[
      {
        topic:"Tính từ quốc tịch — Accord masculin/féminin",
        rule:`Tính từ quốc tịch phải ĐỒI GIỚI với người được nói đến.

QUY TẮC THÀNH LẬP GIỐNG CÁI:
1. Thêm -e: français→française, américain→américaine, anglais→anglaise
   ⚠️ Phát âm khác nhau! [frɑ̃sɛ] → [frɑ̃sɛz]

2. Thêm -ne (với -ien, -éen): italien→italienne, coréen→coréenne, brésilien→brésilienne

3. Thêm -que (ngoại lệ): grec→grecque, turc→turque

4. Không đổi (đã có -e): belge, russe, suisse, tchèque, mexicaine...

5. Đặc biệt: espagnol→espagnole

💡 Tính từ quốc tịch KHÔNG viết hoa khi dùng như tính từ!
✅ Il est français.  ❌ Il est Français.
✅ C'est un Français. (danh từ → viết hoa)`,
        examples:[
          "Il est japonais. Elle est japonaise. — Anh ấy / Cô ấy là người Nhật.",
          "Il est brésilien. Elle est brésilienne. — Anh ấy / Cô ấy là người Brazil.",
          "Il est belge. Elle est belge aussi. — Anh ấy người Bỉ. Cô ấy cũng vậy.",
          "Tu es vietnamien(ne)? — Bạn là người Việt Nam à?",
          "Nous sommes américains. — Chúng tôi là người Mỹ. (nhóm nam hoặc hỗn hợp)",
          "Elles sont italiennes. — Họ là những người phụ nữ Ý.",
        ]
      },
      {
        topic:"Mạo từ xác định — Le, La, L', Les",
        rule:`Mạo từ xác định dùng khi nói về thứ gì đó CỤ THỂ, đã biết, hoặc CHUNG CHUNG theo loại.

• LE + danh từ nam số ít: le cinéma, le sport, le café
• LA + danh từ nữ số ít: la musique, la France, la rue
• L' + danh từ bắt đầu bằng nguyên âm (a,e,i,o,u) hoặc h câm: l'art, l'ami, l'histoire
• LES + tất cả danh từ số nhiều: les langues, les films, les amis

Dùng le/la/les để:
✅ Nói về sở thích (chung chung): J'aime LA musique. (âm nhạc nói chung)
✅ Chỉ thứ cụ thể: C'est le livre de Marie.
✅ Tên nước, vùng: la France, le Vietnam, les États-Unis

⚠️ Tên nước có mạo từ! la France, le Japon, les Pays-Bas
⚠️ Tên thành phố KHÔNG có mạo từ! à Paris (không phải à la Paris)

💡 Phân biệt:
"J'aime LE cinéma." = Tôi thích điện ảnh (nói chung)
"J'aime CE film." = Tôi thích bộ phim này (cụ thể)`,
        examples:[
          "J'aime le sport et la musique. — Tôi thích thể thao và âm nhạc.",
          "Il parle l'anglais et le français. — Anh ấy nói tiếng Anh và tiếng Pháp.",
          "Les Français aiment le fromage. — Người Pháp thích phô mai.",
          "La France est un beau pays. — Pháp là một đất nước đẹp.",
          "L'art et l'histoire m'intéressent. — Nghệ thuật và lịch sử thu hút tôi.",
          "J'adore les films français! — Tôi rất thích phim Pháp!",
        ]
      },
      {
        topic:"Giới từ trước tên thành phố và quốc gia (1) — À, Au, En, Aux",
        rule:`Giới từ chỉ ĐỊA ĐIỂM (ở đâu) hay XUẤT PHÁT (từ đâu):

ĐỐI VỚI THÀNH PHỐ → À (luôn luôn)
• à Paris, à Tokyo, à Hanoï, à New York

ĐỐI VỚI QUỐC GIA:
• EN + nước nữ (kết thúc bằng -e): en France, en Chine, en Espagne, en Italie
• EN + nước bắt đầu bằng nguyên âm (dù nam): en Iran, en Irak, en Angola
• AU = à + le → nước nam: au Japon, au Canada, au Vietnam, au Brésil
• AUX = à + les → nước số nhiều: aux États-Unis, aux Pays-Bas

BẢNG TÓM TẮT:
Ville       → à Paris, à Genève
Pays féminin → en France, en Suisse, en Chine
Pays masculin → au Japon, au Canada
Pays pluriel  → aux États-Unis, aux Pays-Bas
Pays/voyelle  → en Iran, en Angola

💡 Hầu hết nước kết thúc bằng -e là nữ: France, Chine, Espagne...
⚠️ Ngoại lệ nam dù có -e: le Mexique, le Mozambique, le Cambodge`,
        examples:[
          "J'habite à Paris. — Tôi sống ở Paris.",
          "Elle est née en France. — Cô ấy sinh ở Pháp.",
          "Il habite au Canada. — Anh ấy sống ở Canada.",
          "Nous habitons aux États-Unis. — Chúng tôi sống ở Mỹ.",
          "Tu vas en Espagne cet été? — Bạn đi Tây Ban Nha mùa hè này à?",
          "Il est né au Vietnam et il habite en France. — Anh ấy sinh ở Việt Nam và sống ở Pháp.",
        ]
      },
      {
        topic:"Tính từ nghi vấn — Quel, Quelle, Quels, Quelles",
        rule:`QUEL = "nào / gì / bao nhiêu" — dùng để hỏi thông tin cụ thể.

Quel PHẢI ĐỒI GIỚI VÀ SỐ với danh từ mà nó đi kèm:
• QUEL   + danh từ nam số ít:  Quel âge? Quel est ton prénom?
• QUELLE + danh từ nữ số ít:  Quelle heure? Quelle est ta nationalité?
• QUELS  + danh từ nam số nhiều: Quels films tu aimes?
• QUELLES+ danh từ nữ số nhiều: Quelles langues tu parles?

Hai cách dùng:
1. Quel/Quelle + nom directement: Quel jour? Quelle ville?
2. Quel/Quelle + être + nom: Quel est ton numéro? Quelle est ton adresse?

💡 Phát âm: quel/quelle/quels/quelles đều đọc là [kɛl] — phát âm như nhau!
💡 Khác với QUI (ai?) và QU'EST-CE QUE (cái gì?) — quel đi với danh từ.`,
        examples:[
          "Quel est ton prénom? — Tên của bạn là gì?",
          "Quelle est ta nationalité? — Quốc tịch của bạn là gì?",
          "Tu as quel âge? — Bạn bao nhiêu tuổi?",
          "Quelle heure est-il? — Bây giờ là mấy giờ?",
          "Quels sports tu pratiques? — Bạn chơi những môn thể thao nào?",
          "Quelles langues vous parlez? — Bạn nói những ngôn ngữ nào?",
        ]
      },
      {
        topic:"Les nombres 32–100 — Số đếm từ 32 đến 100",
        rule:`SỐ 32–69 → Quy tắc bình thường:
32=trente-deux, 40=quarante, 41=quarante et un,
50=cinquante, 60=soixante, 61=soixante et un

SỐ 70–79 → Bắt đầu rắc rối!
70 = soixante-DIX (60+10), 71 = soixante et onze (60+11)
72 = soixante-douze, 73 = soixante-treize...
79 = soixante-dix-neuf

SỐ 80–89 → Còn rắc rối hơn!
80 = quatre-vingts (4×20, có -s!)
81 = quatre-vingt-un (không có "et", không có -s!)
82 = quatre-vingt-deux... 89 = quatre-vingt-neuf

SỐ 90–99:
90 = quatre-vingt-DIX (80+10)
91 = quatre-vingt-onze... 99 = quatre-vingt-dix-neuf

100 = cent

⚠️ Ngoại lệ Bỉ và Thụy Sĩ:
70 = septante (dễ hơn!), 80 = huitante (Thụy Sĩ), 90 = nonante

💡 Mẹo nhớ: 80 = 4×20, 70 = 60+10, 90 = 80+10`,
        examples:[
          "J'ai trente-cinq ans. — Tôi 35 tuổi.",
          "Il y a soixante élèves. — Có 60 học sinh.",
          "Ça coûte soixante-dix euros. — Cái đó giá 70 euro.",
          "Elle a quatre-vingts ans! — Bà ấy 80 tuổi!",
          "C'est au numéro quatre-vingt-dix-neuf. — Đó là số 99.",
          "Le billet coûte cent euros. — Vé giá 100 euro.",
        ]
      },
    ]
  },
  {
    id:"g2", num:"2", title:"Près de moi", points:[
      {
        topic:"Mạo từ xác định và bất định — Le/La/Les vs Un/Une/Des",
        rule:`HAI LOẠI MẠO TỪ — phân biệt rất quan trọng!

MẠO TỪ BẤT ĐỊNH (indéfini) → nói về thứ CHƯA XÁC ĐỊNH:
• UN  + danh từ nam số ít: un appartement, un ami, un film
• UNE + danh từ nữ số ít: une maison, une amie, une rue
• DES + số nhiều (nam và nữ): des amis, des maisons

MẠO TỪ XÁC ĐỊNH (défini) → nói về thứ ĐÃ BIẾT hoặc CỤ THỂ:
• LE / LA / L' / LES (đã học ở Unité 1)

⚠️ Sau phủ định → thay un/une/des bằng DE (d'):
J'ai un frère. → Je n'ai PAS DE frère.
Il a des amis. → Il n'a PAS D'amis.
(Le/la/les giữ nguyên sau phủ định: Je n'aime pas LE sport.)

💡 Nhớ quy tắc "lần đầu gặp → bất định, lần sau → xác định":
"J'ai UN chat. LE chat s'appelle Mimi."`,
        examples:[
          "J'habite dans un appartement. — Tôi sống trong một căn hộ.",
          "C'est le quartier du centre-ville. — Đó là khu trung tâm (cụ thể).",
          "Il y a des parcs sympas ici. — Ở đây có những công viên dễ thương.",
          "Je n'ai pas d'amis ici. — Tôi không có bạn bè ở đây.",
          "Je cherche une collocataire. LE logement est grand. — Tôi tìm người ở cùng. Chỗ ở khá rộng.",
        ]
      },
      {
        topic:"Động từ đuôi -ER ở thì hiện tại — Présent de l'indicatif",
        rule:`NHÓM 1: Động từ đuôi -ER (nhiều nhất, dễ nhất!)
Bỏ -er, thêm: -e / -es / -e / -ons / -ez / -ent

Ví dụ AIMER (yêu thích):
• J'aime     (j' vì nguyên âm!)
• Tu aimes
• Il/Elle aime
• Nous aimons
• Vous aimez
• Ils/Elles aiment

Một số động từ đặc biệt trong nhóm:
• ACHETER: j'achète (thêm accent grave ở tu, il)
• APPELER: j'appelle (đôi phụ âm: tu appelles, il appelle)
• PRÉFÉRER: je préfère (accent grave: tu préfères, il préfère)

PHỦ ĐỊNH: Ne + verbe + pas
J'aime → Je N'aime PAS
Il habite → Il N'habite PAS

DẠNG HỎIVỀ: Est-ce que tu aimes? hoặc Tu aimes?
DẠNG HỎI LỊCH SỰ: Aimez-vous le sport? (đảo ngữ)`,
        examples:[
          "J'aime la musique mais je déteste le sport. — Tôi thích âm nhạc nhưng ghét thể thao.",
          "Tu habites où? — Bạn sống ở đâu?",
          "Elle n'aime pas skier. — Cô ấy không thích trượt tuyết.",
          "Nous adorons voyager ensemble. — Chúng tôi rất thích du lịch cùng nhau.",
          "Ils dansent très bien. — Họ nhảy rất đẹp.",
          "Est-ce que vous parlez anglais? — Bạn có nói tiếng Anh không?",
        ]
      },
      {
        topic:"Tính từ sở hữu — Mon/Ma/Mes, Ton/Ta/Tes, Son/Sa/Ses…",
        rule:`Tính từ sở hữu chỉ ra VẬT THUỘC VỀ AI. Nó đồng ý với ĐỐI TƯỢNG SỞ HỮU (không phải chủ sở hữu)!

       Nam sg  | Nữ sg | Số nhiều
1 người: mon   |  ma   |  mes   (của tôi)
         ton   |  ta   |  tes   (của bạn)
         son   |  sa   |  ses   (của anh/cô ấy)
Nhiều:  notre  | notre |  nos   (của chúng tôi)
        votre  | votre |  vos   (của các bạn)
        leur   | leur  | leurs  (của họ)

⚠️ Quan trọng: SON/SA/SES có thể là "của anh ấy" HOẶC "của cô ấy"!
Paul et SA sœur = em gái của Paul
Marie et SA sœur = em gái của Marie

⚠️ Ngoại lệ phát âm: Mon/Ton/Son + danh từ nữ bắt đầu nguyên âm!
mon amie (không phải ma amie — khó đọc)
ton école, son histoire

💡 Mẹo: "mon livre" → quyển sách của tôi (livre=nam → mon)
"ma voiture" → xe của tôi (voiture=nữ → ma)`,
        examples:[
          "Mon père est médecin et ma mère est professeure. — Bố tôi là bác sĩ, mẹ tôi là giáo viên.",
          "Tes amis sont sympas. — Bạn bè của bạn thật dễ mến.",
          "Son chien s'appelle Rex. — Con chó của anh/cô ấy tên Rex.",
          "Notre appartement est grand. — Căn hộ của chúng tôi rộng.",
          "Leurs enfants adorent le sport. — Những đứa con của họ rất thích thể thao.",
          "C'est mon amie. (pas ma amie!) — Đây là bạn gái của tôi.",
        ]
      },
      {
        topic:"Giống đực/cái của danh từ nghề nghiệp — Masculin/Féminin",
        rule:`Danh từ nghề nghiệp cũng phải đổi giống! Các quy tắc chính:

1. KHÔNG ĐỔI (đuôi -e): artiste, journaliste, libraire, secrétaire, comptable, architecte
   → Il est artiste. Elle est artiste.

2. THÊM -E: étudiant→étudiante, client→cliente, assistant→assistante

3. ĐUÔI -EUR → -EUSE: coiffeur→coiffeuse, vendeur→vendeuse, danseur→danseuse

4. ĐUÔI -TEUR → -TRICE: acteur→actrice, directeur→directrice, professeur⚠️

5. ĐUÔI -ER → -ÈRE: boulanger→boulangère, boucher→bouchère, infirmier→infirmière

6. HOÀN TOÀN KHÁC: homme→femme de ménage

⚠️ Professeur: truyền thống là nam, nhưng ngày nay dùng "professeure" cho nữ
⚠️ Médecin: theo truyền thống không đổi, nhưng "médecine" đang được dùng

💡 Tên nghề không có mạo từ sau être:
"Je suis étudiant(e)." (không phải "Je suis UN étudiant" — trừ khi có tính từ đi kèm)`,
        examples:[
          "Il est acteur. Elle est actrice. — Anh ấy là diễn viên. Cô ấy là diễn viên.",
          "Mon père est boulanger. Ma mère est boulangère. — Bố tôi là thợ làm bánh. Mẹ tôi cũng vậy.",
          "Elle est infirmière à l'hôpital. — Cô ấy là y tá ở bệnh viện.",
          "C'est un bon vendeur. Elle est vendeuse aussi. — Anh ấy là nhân viên bán hàng giỏi.",
          "Je suis étudiant(e) en français. — Tôi là sinh viên học tiếng Pháp.",
        ]
      },
    ]
  },
  {
    id:"g3", num:"3", title:"Qu'est-ce qu'on mange?", points:[
      {
        topic:"Số ít và số nhiều của danh từ — Singulier et pluriel",
        rule:`QUY TẮC THÀNH LẬP SỐ NHIỀU:

1. THÊM -S (phổ biến nhất): un pain→des pains, une pomme→des pommes
   ⚠️ Số -s KHÔNG đọc trong tiếng Pháp! pains [pɛ̃] = pain [pɛ̃]

2. ĐÃ KẾT THÚC -S, -X, -Z → không đổi: une voix→des voix, un bras→des bras

3. -EAU, -EU → thêm -X: un gâteau→des gâteaux, un jeu→des jeux, un tableau→des tableaux

4. -AL → -AUX: un journal→des journaux, un animal→des animaux
   Ngoại lệ: un bal→des bals, un festival→des festivals, un carnaval→des carnavals

5. Bất quy tắc phải học thuộc:
   un œuf [oef]→des œufs [ø] (câm!)
   un monsieur→des messieurs
   madame→mesdames

⚠️ Mạo từ số nhiều: UN/UNE → DES; LE/LA/L' → LES
⚠️ Sau phủ định: DES → DE: J'ai des amis → Je n'ai PAS D'amis`,
        examples:[
          "Je voudrais un croissant. → Mme Martin achète trois croissants. — Ba cái bánh sừng bò.",
          "Il y a un beau gâteau. → Il y a de beaux gâteaux. — Có những cái bánh đẹp.",
          "Un journal → des journaux. — Một tờ báo → nhiều tờ báo.",
          "Un œuf [oef] → des œufs [ø]. — Phát âm thay đổi hoàn toàn!",
          "Ce sont des fruits et des légumes de saison. — Đây là trái cây và rau củ theo mùa.",
        ]
      },
      {
        topic:"Giới từ chỉ nơi chốn (1) — À la, Au, À l', Aux, Chez",
        rule:`ĐI ĐÂU hoặc Ở ĐÂU — hai loại giới từ:

VỚI NƠI CHỐN (lieux) — dùng À + mạo từ:
• À + LA → à la boulangerie, à la poste, à la pharmacie
• À + LE → AU marché, au café, au supermarché, au restaurant
• À + L' → à l'épicerie, à l'hôpital, à l'école
• À + LES → AUX caisses, aux Champs-Élysées, aux urgences

VỚI NGƯỜI (personnes) — dùng CHEZ:
• chez le médecin (ở chỗ bác sĩ)
• chez le boulanger (ở tiệm người làm bánh)
• chez moi/toi/lui/elle (ở nhà tôi/bạn/anh ấy...)
• chez mes parents (ở nhà bố mẹ tôi)

💡 CHEZ vs À:
"Je vais à la boulangerie." = Tôi đến tiệm bánh (địa điểm)
"Je vais chez le boulanger." = Tôi đến chỗ người làm bánh (người)

⚠️ Chez McDonald's, chez IKEA → dùng chez với thương hiệu (như tên người)`,
        examples:[
          "Je vais à la boulangerie acheter du pain. — Tôi đến tiệm bánh mua bánh mì.",
          "Il est au marché ce matin. — Anh ấy đang ở chợ sáng nay.",
          "On va à l'épicerie? — Mình đến tạp hóa nhé?",
          "Elle achète le fromage chez le fromager. — Cô ấy mua phô mai ở tiệm phô mai.",
          "Ce soir, on dîne chez mes parents. — Tối nay chúng tôi ăn tối ở nhà bố mẹ.",
          "Je paye aux caisses automatiques. — Tôi thanh toán ở máy tự động.",
        ]
      },
      {
        topic:"Mạo từ phân lượng — Du, De la, De l', Des",
        rule:`Mạo từ phân lượng dùng khi nói về SỐ LƯỢNG KHÔNG ĐẾM ĐƯỢC.

• DU  = DE + LE → nom masculin: du pain, du beurre, du fromage, du lait
• DE LA → nom féminin: de la farine, de la crème, de la viande
• DE L' → nom bắt đầu bằng nguyên âm: de l'eau, de l'huile, de l'ail
• DES → nom pluriel: des pâtes, des légumes, des fruits

Dùng khi:
✅ Nói về lượng không xác định: "Je mange du pain." (một lượng nào đó)
✅ Các chất liệu: du coton, du bois, de la soie
✅ Khái niệm trừu tượng: du courage, de la patience

BIẾN ĐỔI SAU PHỦ ĐỊNH:
Mọi mạo từ phân lượng → DE/D' sau phủ định!
"Je bois du café." → "Je ne bois PAS DE café."
"Il y a de la neige." → "Il n'y a PAS DE neige."

SỐ LƯỢNG CỤ THỂ thay thế mạo từ phân lượng:
un peu de, beaucoup de, assez de, trop de, un kilo de, une bouteille de...
→ "un peu de sel" (không phải "un peu du sel")`,
        examples:[
          "Le matin, je mange du pain avec de la confiture. — Sáng tôi ăn bánh mì với mứt.",
          "Tu veux de l'eau ou du jus? — Bạn muốn nước hay nước ép?",
          "Je ne mange pas de viande. — Tôi không ăn thịt.",
          "Il faut de la farine pour faire un gâteau. — Cần bột mì để làm bánh.",
          "Un peu de sel, beaucoup de poivre! — Một chút muối, nhiều tiêu!",
          "Il n'y a plus de lait. — Hết sữa rồi.",
        ]
      },
      {
        topic:"Động từ đuôi -IR nhóm 2 — Choisir, Finir",
        rule:`NHÓM 2: Động từ đuôi -IR (nhóm quy tắc)
Nhận biết: thêm -ISS- vào phần nous/vous/ils!

Chia CHOISIR (chọn):
• Je choisis     • Nous choisissons
• Tu choisis     • Vous choisissez
• Il/Elle choisit  • Ils/Elles choisissent

Chia FINIR (kết thúc / ăn hết):
• Je finis       • Nous finissons
• Tu finis       • Vous finissez
• Il/Elle finit    • Ils/Elles finissent

Các động từ tương tự: réussir (thành công), grossir (tăng cân), maigrir (giảm cân), rougir (đỏ mặt), vieillir (già đi), grandir (lớn lên)

⚠️ Đừng nhầm với -IR nhóm 3 (bất quy tắc) như partir, sortir, dormir → chia khác!
"Je pars" (không phải "je partis" ở thì hiện tại)`,
        examples:[
          "Je choisis le menu à 15 euros. — Tôi chọn thực đơn 15 euro.",
          "Tu finis ton dessert? — Bạn ăn hết món tráng miệng chưa?",
          "Nous choisissons un bon restaurant pour ce soir. — Chúng tôi chọn nhà hàng ngon cho tối nay.",
          "Les étudiants réussissent à l'examen. — Các sinh viên thi đỗ.",
          "Elle rougit quand elle parle en public. — Cô ấy đỏ mặt khi nói trước đám đông.",
        ]
      },
    ]
  },
  {
    id:"g4", num:"4", title:"C'est où?", points:[
      {
        topic:"C'est / Il est — Phân biệt cách dùng",
        rule:`Đây là một trong những điểm khó nhất cho người học tiếng Pháp!

C'EST → để NHẬN DẠNG, GIỚI THIỆU (dùng với danh từ)
• C'est + un/une + nom: C'est un musée. C'est une artiste.
• C'est + le/la/les + nom: C'est le Louvre. C'est la Tour Eiffel.
• C'est + nom propre: C'est Paris. C'est Marie.
• Ce sont + pluriel: Ce sont des étudiants.

IL/ELLE EST → để MÔ TẢ (dùng với tính từ)
• Il/Elle est + adjectif: Il est grand. Elle est belle.
• Il/Elle est + profession (sans article!): Elle est médecin.
• Il/Elle est + nationalité: Il est français.

CẢ HAI ĐỀU ĐÚNG nhưng khác nghĩa:
"C'est un Français." = Anh ta là người Pháp (nhận dạng danh từ → có mạo từ!)
"Il est français." = Anh ta người Pháp (tính từ → không mạo từ!)

"C'est une actrice célèbre." = Cô ấy là diễn viên nổi tiếng (giới thiệu)
"Elle est célèbre." = Cô ấy nổi tiếng (miêu tả)`,
        examples:[
          "C'est le Musée d'Orsay. Il est magnifique! — Đó là Bảo tàng Orsay. Nó thật đẹp!",
          "C'est une étudiante. Elle est intelligente. — Đây là một sinh viên. Cô ấy thông minh.",
          "Ce sont des artistes. Ils sont très talentueux. — Họ là các nghệ sĩ. Họ rất tài năng.",
          "C'est mon quartier. Il est calme et sympa. — Đây là khu phố của tôi. Nó yên tĩnh và dễ chịu.",
          "Elle est professeure. (profession, pas d'article!) — Cô ấy là giáo viên.",
        ]
      },
      {
        topic:"Mệnh lệnh thức — L'impératif",
        rule:`IMPÉRATIF dùng để: RA LỆNH, ĐỀ NGHỊ, KHUYÊN BẢO, CHỈ ĐƯỜNG

Chỉ có 3 ngôi: TU / NOUS / VOUS
Xây dựng từ thì présent, BỎ đại từ:
• Tu vas → Va! (đi đi!)
• Nous allons → Allons! (nào đi!)
• Vous venez → Venez! (hãy đến!)

⚠️ QUAN TRỌNG: Verbes en -ER → bỏ -S ở ngôi TU!
Parler: Tu parles → Parle! (không phải Parles!)
Écouter: Tu écoutes → Écoute!
Trừ: "Vas-y!" (trước y hoặc en, giữ -s để phát âm đẹp)

ĐỘNG TỪ BẤT QUY TẮC:
• Être:  Sois! Soyons! Soyez!
• Avoir: Aie! Ayons! Ayez!
• Savoir: Sache! Sachons! Sachez!
• Vouloir: Veuille! Veuillons! Veuillez! (rất lịch sự)

PHỦ ĐỊNH: Ne + verbe + pas
"Ne tourne pas à droite! Tourne à gauche!"

PHẢN THÂN: Pronom APRÈS le verbe (avec trait d'union):
"Lève-toi!" (te→toi), "Levons-nous!", "Levez-vous!"`,
        examples:[
          "Tourne à droite puis continue tout droit! — Rẽ phải rồi đi thẳng!",
          "Prenons le métro, c'est plus rapide. — Chúng ta đi tàu điện ngầm, nhanh hơn.",
          "Parle moins vite, s'il te plaît! — Nói chậm hơn một chút nhé!",
          "Ne traverse pas ici! — Đừng băng qua đường ở đây!",
          "Soyez à l'heure, s'il vous plaît. — Xin hãy đúng giờ.",
          "Lève-toi! Il est 8 heures! — Dậy đi! 8 giờ rồi!",
        ]
      },
      {
        topic:"Liên từ — Pour, Parce que, Mais, Avec, Sans",
        rule:`Các liên từ và giới từ nối câu:

POUR + INFINITIF → mục đích (để làm gì)
"Je prends le bus pour aller au travail." (để đi làm)
⚠️ Không dùng "pour que" + subjonctif ở trình độ A1

PARCE QUE + PHRASE COMPLÈTE → lý do (vì...)
"Je prends le bus parce que c'est moins cher."
⚠️ Parce qu' trước nguyên âm: "parce qu'il fait froid"
Khác với CAR (vì) — trang trọng hơn, viết văn

MAIS → đối lập (nhưng)
"J'aime Paris mais c'est cher."
"Il est sympa mais un peu timide."

AVEC + NOM → có/cùng với
"Je bois un café avec du lait." "Je viens avec mes amis."
Sans avoir de verbe: "un café avec du sucre"

SANS + NOM/INFINITIF → không có/không làm
"Un café sans sucre." "Je pars sans manger."`,
        examples:[
          "Je prends le métro pour aller à l'université. — Tôi đi tàu điện để đến trường.",
          "Je reste à la maison parce qu'il pleut. — Tôi ở nhà vì trời mưa.",
          "J'aime ce quartier mais il est bruyant. — Tôi thích khu này nhưng nó ồn ào.",
          "Je prends un café avec du lait et sans sucre. — Tôi uống cà phê có sữa và không đường.",
          "Elle part sans dire au revoir. — Cô ấy ra đi không nói lời tạm biệt.",
        ]
      },
    ]
  },
  {
    id:"g5", num:"5", title:"C'est tendance!", points:[
      {
        topic:"Accord des adjectifs — Masculin, Féminin, Pluriel",
        rule:`Tính từ trong tiếng Pháp phải ĐỒNG Ý với danh từ nó bổ nghĩa (giống và số)!

THÀNH LẬP GIỐNG CÁI:
1. Thêm -E: grand→grande, petit→petite, noir→noire, vert→verte
   ⚠️ Nếu đã có -E, không đổi: rouge, jaune, jeune, russe, belge
2. Đôi phụ âm cuối + E: bon→bonne, gros→grosse, bas→basse
3. -EUX → -EUSE: heureux→heureuse, sérieux→sérieuse, courageux→courageuse
4. -F → -VE: actif→active, neuf→neuve, sportif→sportive
5. -ER → -ÈRE: cher→chère, léger→légère, premier→première
6. Bất quy tắc: beau→belle, nouveau→nouvelle, vieux→vieille, blanc→blanche, doux→douce, long→longue

THÀNH LẬP SỐ NHIỀU:
• Thêm -S: grand→grands, grande→grandes
• Đã có -S/-X: gros→gros, heureux→heureux
• -EAU → -EAUX: beau→beaux, nouveau→nouveaux

⚠️ Màu sắc từ tên vật → KHÔNG ĐỔI: orange, marron, kaki, crème
"Des chaussures orange." (không phải oranges)`,
        examples:[
          "Un pull noir, une robe noire, des pulls noirs, des robes noires.",
          "Il est actif. Elle est active. Ils sont actifs. Elles sont actives.",
          "C'est un beau sac! C'est une belle robe! Ce sont de beaux vêtements!",
          "Un gilet gris, une veste grise, des chaussures grises.",
          "Des chaussures marron. (couleur = invariable!)",
          "Elle porte une jupe longue et un pull court.",
        ]
      },
      {
        topic:"Thì tương lai gần — Le Futur Proche",
        rule:`FUTUR PROCHE = nói về hành động SẮP XẢY RA

Cấu trúc: ALLER (présent) + INFINITIF

Chia ALLER ở présent:
• Je vais     • Nous allons
• Tu vas      • Vous allez
• Il/Elle va  • Ils/Elles vont

Dùng futur proche khi:
✅ Hành động sắp xảy ra trong tương lai gần: "Je vais partir dans 5 minutes."
✅ Dự định đã lên kế hoạch: "Ce soir, nous allons au cinéma."
✅ Dự đoán chắc chắn: "Il va pleuvoir."
✅ Khẩu ngữ: thường dùng hơn futur simple trong giao tiếp hàng ngày

PHỦ ĐỊNH: Ne + ALLER + pas + INFINITIF
"Je ne vais pas sortir ce soir." (Tôi sẽ không ra ngoài tối nay)

ĐẠI TỪ: se place avant l'infinitif:
"Il va se lever tard." (không phải "Il va lever se tard")

💡 Mẹo phân biệt:
Futur proche: action très bientôt, intime conviction
Futur simple: plus lointain, formel, promesse`,
        examples:[
          "Je vais acheter une nouvelle veste. — Tôi sắp mua một chiếc áo vest mới.",
          "Il va faire froid ce week-end. — Cuối tuần này sẽ lạnh.",
          "Nous allons organiser une fête. — Chúng tôi sắp tổ chức một bữa tiệc.",
          "Tu vas partir quand? — Bạn sắp đi khi nào?",
          "Elle ne va pas venir ce soir. — Cô ấy sẽ không đến tối nay.",
          "Ils vont se marier en juin. — Họ sắp kết hôn vào tháng 6.",
        ]
      },
      {
        topic:"Vị trí của tính từ — La place des adjectifs",
        rule:`Trong tiếng Pháp, tính từ có thể đứng TRƯỚC hoặc SAU danh từ!

QUY TẮC CHUNG → SAU DANH TỪ:
Đặc biệt: màu sắc, hình dạng, quốc tịch, tôn giáo, kỹ thuật
"un livre rouge, une table ronde, un film français, un cours intéressant"

TÍNH TỪ NGẮN THƯỜNG GẶP → TRƯỚC DANH TỪ:
Nhớ qua từ khóa "BAGS" hoặc "BANGS":
• Beauté: beau/belle, joli(e)
• Âge: vieux/vieille, jeune, nouveau/nouvelle
• Grandeur: grand(e), petit(e), gros(se), long(ue), court(e), haut(e)
• Qualité subjective: bon(ne), mauvais(e), meilleur(e)

⚠️ Khi tính từ đứng TRƯỚC danh từ số nhiều → DES đổi thành DE/D':
"des fleurs rouges" NHƯNG "de belles fleurs" (pas des belles fleurs)

⚠️ Một số tính từ đổi nghĩa tùy vị trí:
"un homme grand" = người đàn ông cao
"un grand homme" = một vĩ nhân
"une robe chère" = chiếc váy đắt
"ma chère amie" = người bạn thân yêu`,
        examples:[
          "C'est un grand sac noir. — Đây là một chiếc túi đen to.",
          "J'ai une jolie robe bleue. — Tôi có một chiếc váy xanh xinh.",
          "C'est un bon restaurant français. — Đây là một nhà hàng Pháp ngon.",
          "Elle porte de belles chaussures. (pas des belles!) — Cô ấy mang đôi giày đẹp.",
          "Il a acheté une nouvelle voiture rouge. — Anh ấy đã mua một chiếc xe đỏ mới.",
        ]
      },
      {
        topic:"Tính từ chỉ định — Ce, Cet, Cette, Ces",
        rule:`Tính từ chỉ định = "này / đó / kia" — dùng để chỉ vào vật cụ thể

• CE   + danh từ nam bắt đầu bằng phụ âm: ce pull, ce sac, ce garçon
• CET  + danh từ nam bắt đầu bằng nguyên âm hoặc h câm: cet imperméable, cet homme, cet objet
• CETTE + danh từ nữ (mọi trường hợp): cette robe, cette idée, cette image
• CES  + danh từ số nhiều (mọi giống): ces chaussures, ces pulls, ces objets

Phát âm: ce/cet/cette/ces đều đọc là [sə] / [sɛt] / [sɛ]

Thêm -CI (gần) hoặc -LÀ (xa) sau danh từ để phân biệt:
"ce pull-CI" (cái áo len này, gần) vs "ce pull-LÀ" (cái áo len kia, xa)

💡 Cet vs Ce: chỉ khác nhau trước nguyên âm để dễ phát âm hơn
"Ce ami" → khó đọc → "Cet ami" [sɛtami]`,
        examples:[
          "Ce pull est très chaud. — Cái áo len này rất ấm.",
          "Cet imperméable est pratique. — Chiếc áo mưa đó thực tế.",
          "Cette robe est magnifique! — Chiếc váy này thật đẹp!",
          "Ces chaussures sont confortables. — Những đôi giày này thoải mái.",
          "Tu préfères ce modèle-ci ou ce modèle-là? — Bạn thích mẫu này hay mẫu kia?",
          "Cet objet, c'est quoi exactement? — Cái vật này là cái gì vậy?",
        ]
      },
    ]
  },
  {
    id:"g6", num:"6", title:"Qu'est-ce qu'on fait aujourd'hui?", points:[
      {
        topic:"Động từ phản thân — Les verbes pronominaux",
        rule:`Động từ phản thân = hành động TỰ LÀM CHO MÌNH (se + verbe)

Bảng chia SE LEVER (thức dậy):
• Je me lève      (me trước nguyên âm → m')
• Tu te lèves     (te → t' trước nguyên âm)
• Il/Elle se lève  (se → s' trước nguyên âm)
• Nous nous levons
• Vous vous levez
• Ils/Elles se lèvent

Các loại động từ phản thân:
1. Thực sự phản thân (tự làm cho mình): se laver, se coiffer, se maquiller, se raser
2. Nghĩa đặc biệt khác động từ gốc: s'appeler (tên là) ≠ appeler (gọi)
   se trouver (nằm ở) ≠ trouver (tìm thấy)
3. Luôn luôn phản thân (không có dạng không phản thân):
   se souvenir (nhớ), se taire (im lặng), se méfier (cảnh giác)

PHỦ ĐỊNH: Ne + me/te/se + verbe + pas
"Je ne me lève pas tôt." (Tôi không dậy sớm)

⚠️ Ở thì PASSÉ COMPOSÉ: Être (không avoir!) + participe passé
"Je me suis levé(e) à 7h."`,
        examples:[
          "Je me réveille à 7h et je me lève à 7h15. — Tôi thức lúc 7h và dậy lúc 7h15.",
          "Il se douche et se rase le matin. — Anh ấy tắm và cạo râu buổi sáng.",
          "Nous nous couchons tard le week-end. — Chúng tôi đi ngủ muộn vào cuối tuần.",
          "Elle s'habille vite. — Cô ấy mặc đồ nhanh.",
          "Comment tu t'appelles? — Bạn tên là gì?",
          "Je ne me maquille pas tous les jours. — Tôi không trang điểm mỗi ngày.",
        ]
      },
      {
        topic:"Trạng từ tần suất (2) — Parfois, Rarement, Tous les…",
        rule:`Thang tần suất từ thấp đến cao:
jamais (0%) < rarement < parfois/quelquefois < souvent < toujours (100%)

VỊ TRÍ TRONG CÂU:
• Sau động từ (thì hiện tại, passé composé phần avoir): Je vais SOUVENT au cinéma.
• Trước participe passé: J'ai SOUVENT regardé ce film.

BIỂU THỨC THỜI GIAN (đứng đầu hoặc cuối câu):
• le lundi = mỗi thứ Hai: Le lundi, je fais du yoga.
• tous les lundis = every Monday: Je fais du yoga tous les lundis.
• tous les jours = chaque jour: Il court tous les jours.
• tous les matins/soirs = chaque matin/soir
• le week-end = chaque week-end
• une fois par semaine/mois = một lần mỗi tuần/tháng
• de temps en temps = thỉnh thoảng

⚠️ JAMAIS avec ne → jamais sans ne = argot/informal
"Je ne vais jamais là-bas." (standard)
"Je vais jamais là-bas." (familier)`,
        examples:[
          "Je vais parfois au théâtre, mais jamais à l'opéra. — Tôi thỉnh thoảng đi xem kịch nhưng không bao giờ đi opera.",
          "Le lundi, je fais du sport. Tous les lundis! — Thứ Hai tôi tập thể thao. Mỗi thứ Hai!",
          "Elle travaille toujours tard le soir. — Cô ấy luôn làm việc muộn buổi tối.",
          "Tu sors souvent le week-end? — Bạn hay ra ngoài vào cuối tuần không?",
          "Je fais du yoga deux fois par semaine. — Tôi tập yoga hai lần một tuần.",
          "Il ne va rarement au cinéma. → Sai! Nói: Il va rarement au cinéma.",
        ]
      },
      {
        topic:"Passé récent — Venir de + infinitif",
        rule:`VENIR DE + INFINITIF = "vừa mới làm gì đó" (hành động vừa kết thúc)

Chia VENIR au présent:
• Je viens de     • Nous venons de
• Tu viens de     • Vous venez de
• Il/Elle vient de • Ils/Elles viennent de

Dùng khi:
✅ Hành động xảy ra NGAY TRƯỚC lúc nói: "Je viens de manger." (Tôi vừa mới ăn xong)
✅ Giải thích tại sao không thể làm gì: "Je ne peux pas manger, je viens de finir."

⚠️ VENIR DE + lieu = "vừa đến từ" → nghĩa khác!
"Il vient de Paris." = Anh ấy đến từ Paris. (xuất xứ)
"Il vient DE RENTRER." = Anh ấy vừa mới về. (passé récent)

PHỦ ĐỊNH: Je ne viens pas de + infinitif
"Il ne vient pas de partir." = Anh ấy không vừa đi.

💡 Đây là cách diễn đạt tự nhiên trong tiếng Pháp khẩu ngữ, thường dùng hơn passé composé khi nói về "vừa mới"`,
        examples:[
          "Je viens de finir mon cours de français! — Tôi vừa mới kết thúc bài học tiếng Pháp!",
          "Il vient d'appeler. Tu l'as raté! — Anh ấy vừa gọi. Bạn bỏ lỡ rồi!",
          "Nous venons d'arriver à Paris. — Chúng tôi vừa mới đến Paris.",
          "Désolé, elle vient de partir. — Xin lỗi, cô ấy vừa ra đi.",
          "Tu as faim? Non, je viens de manger. — Bạn đói không? Không, tôi vừa ăn xong.",
        ]
      },
      {
        topic:"Động từ -IR nhóm 3 — Partir, Sortir, Dormir",
        rule:`Nhóm 3 BẤT QUY TẮC: Cách chia KHÁC với nhóm 2!
Đặc điểm: số ít mất phụ âm cuối cùng của phần gốc

PARTIR (khởi hành / rời đi):
• Je pars    Tu pars    Il part
• Nous partons  Vous partez  Ils partent

SORTIR (ra ngoài):
• Je sors    Tu sors    Il sort
• Nous sortons  Vous sortez  Ils sortent

DORMIR (ngủ):
• Je dors    Tu dors    Il dort
• Nous dormons  Vous dormez  Ils dorment

Tương tự: servir (phục vụ), mentir (nói dối), sentir (cảm nhận/ngửi)

⚠️ So sánh với nhóm 2:
Finir (nhóm 2): je finis, nous finissons (có -ISS-)
Partir (nhóm 3): je pars, nous partons (không có -ISS-)

PARTIR vs QUITTER vs LAISSER:
• Partir (de) = rời đi: "Je pars de Paris."
• Quitter + COD = rời bỏ ai/đâu: "Je quitte Paris. Je quitte Marie."
• Laisser = để lại: "Je laisse mon sac ici."`,
        examples:[
          "Je pars à 8h du matin. — Tôi khởi hành lúc 8 giờ sáng.",
          "Tu sors ce soir? — Bạn ra ngoài tối nay không?",
          "Il dort beaucoup le week-end. — Anh ấy ngủ nhiều vào cuối tuần.",
          "Nous partons en vacances demain! — Chúng tôi đi nghỉ hè ngày mai!",
          "Vous dormez combien d'heures par nuit? — Bạn ngủ bao nhiêu tiếng mỗi đêm?",
          "Ils sortent souvent avec des amis. — Họ thường ra ngoài với bạn bè.",
        ]
      },
    ]
  },
  {
    id:"g7", num:"7", title:"Chez moi!", points:[
      {
        topic:"Passé composé (1) — Avec l'auxiliaire AVOIR",
        rule:`PASSÉ COMPOSÉ = thì quá khứ kể chuyện, hành động đã hoàn thành

Cấu trúc: AVOIR (présent) + PARTICIPE PASSÉ

THÀNH LẬP PARTICIPE PASSÉ:
• Verbes en -ER → É: parler→parlé, manger→mangé, trouver→trouvé
• Verbes en -IR (groupe 2) → I: finir→fini, choisir→choisi
• Irréguliers phải học thuộc:
  avoir→eu, être→été, faire→fait, voir→vu, pouvoir→pu,
  vouloir→voulu, devoir→dû, savoir→su, boire→bu,
  prendre→pris, mettre→mis, dire→dit, écrire→écrit

PHỦ ĐỊNH: NE + AVOIR + PAS + PARTICIPE PASSÉ
"Je n'ai pas mangé." "Il n'a pas vu ce film."

⚠️ Avec AVOIR: le participe passé ne s'accorde PAS avec le sujet!
"Elle a mangé." (pas mangée — l'accord se fait seulement avec le COD avant le verbe)

INDICATEURS DE TEMPS:
hier (hôm qua), avant-hier, la semaine dernière, le mois dernier,
il y a + temps: "Il y a deux jours" = hai ngày trước`,
        examples:[
          "J'ai trouvé un bel appartement hier! — Tôi đã tìm được một căn hộ đẹp hôm qua!",
          "Tu as fait les courses? — Bạn đã đi mua sắm chưa?",
          "Il n'a pas vu ce film. — Anh ấy chưa xem bộ phim này.",
          "Nous avons mangé une délicieuse pizza. — Chúng tôi đã ăn một chiếc pizza ngon.",
          "Ils ont eu un problème. — Họ đã gặp vấn đề.",
          "Elle a pris le bus ce matin. — Cô ấy đã bắt xe buýt sáng nay.",
        ]
      },
      {
        topic:"Giới từ chỉ vị trí (2) — Sur, Sous, Devant, Derrière, Entre, En face de…",
        rule:`VỊ TRÍ ĐỒ VẬT trong không gian:

• SUR = trên (tiếp xúc bề mặt): sur la table, sur le lit, sur le mur
• SOUS = dưới: sous la table, sous le lit
• DEVANT = trước (mặt đối mặt): devant la maison, devant toi
• DERRIÈRE = sau (phía sau): derrière la porte, derrière toi
• ENTRE = giữa (hai vật): entre le canapé et la fenêtre
• EN FACE DE = đối diện: en face de la gare, en face de moi
• À CÔTÉ DE = bên cạnh: à côté de la banque
• À DROITE DE = bên phải: à droite du canapé
• À GAUCHE DE = bên trái: à gauche de la porte
• AU-DESSUS DE = phía trên (không tiếp xúc): au-dessus du lit
• EN DESSOUS DE = phía dưới (không tiếp xúc)
• AU FOND DE = ở cuối/trong: au fond du couloir

⚠️ Chú ý: DE + LE = DU, DE + LES = DES
"à côté du canapé" (pas de le canapé)
"en face des fenêtres" (pas de les fenêtres)`,
        examples:[
          "Le chat est sous le lit. — Con mèo ở dưới giường.",
          "Les clés sont sur la table, devant la lampe. — Chìa khóa trên bàn, trước đèn.",
          "Le canapé est entre les deux fauteuils. — Ghế sofa ở giữa hai chiếc ghế bành.",
          "La salle de bains est en face de la chambre. — Phòng tắm đối diện phòng ngủ.",
          "Il y a un miroir à côté de la fenêtre. — Có một cái gương bên cạnh cửa sổ.",
          "Le garage est au fond de la cour. — Gara ở cuối sân.",
        ]
      },
      {
        topic:"Obligation et interdiction (1) — Il faut, Ne pas + infinitif",
        rule:`OBLIGATION ET INTERDICTION — ba cách diễn đạt:

1. IL FAUT + INFINITIF (obligation impersonnelle, générale)
"Il faut respecter le règlement." = Cần phải tôn trọng nội quy.
"Il faut faire du sport." = Cần phải tập thể thao.
Phủ định: "Il ne faut pas + inf." = Không được...
"Il ne faut pas faire de bruit." = Không được làm ồn.

2. INFINITIF seul (panneaux, instructions écrites)
"Ne pas fumer." "Ne pas stationner." "Composer son billet."
→ Style télégraphique pour affiches, règlements, recettes

3. IMPÉRATIF (ordre direct à une personne)
"Fermez la porte!" "Ne faites pas de bruit!"

Mức độ:
• Il faut... (obligation générale, impersonnelle)
• Devoir... (obligation personnelle — voir Unité 8)
• Pouvoir... (permission)
• Ne pas devoir... (interdiction personnelle)
• Il est interdit de... (interdiction formelle)`,
        examples:[
          "Il faut sortir les poubelles le lundi. — Cần đổ rác vào thứ Hai.",
          "Il ne faut pas faire de bruit après 22h. — Không được làm ồn sau 22 giờ.",
          "Ne pas laisser les vélos dans le couloir. — Không để xe đạp trong hành lang.",
          "Il faut respecter les voisins. — Cần tôn trọng hàng xóm.",
          "Fermer la porte à clé. — Hãy khóa cửa. (panneau, infinitif)",
        ]
      },
      {
        topic:"Pronoms COD (1) — Le, La, L', Les",
        rule:`COD = Complément d'Objet Direct = bổ ngữ trực tiếp
Pronoms COD thay thế danh từ để tránh lặp lại!

• LE = thay thế nam sg: le film → je LE regarde
• LA = thay thế nữ sg: la série → je LA regarde
• L' = trước nguyên âm (nam hoặc nữ): l'appartement → je L'ai trouvé
• LES = số nhiều: les clés → je LES ai

VỊ TRÍ: TRƯỚC động từ (sauf impératif affirmatif)
"Je regarde le film." → "Je LE regarde." ✅
"Je LE regarde." → pronom AVANT le verbe ✅

PHỦ ĐỊNH: ne + pronom + verbe + pas
"Je ne LE regarde pas."

IMPÉRATIF AFFIRMATIF: pronom APRÈS, avec trait d'union
"Regarde-LE!" "Appelle-LA!" "Mange-LES!"
⚠️ Le/la → l' avant h aspiré? Non! → "Regarde-le!" toujours

PASSÉ COMPOSÉ: pronom avant l'auxiliaire
"Je l'ai vu." "Tu les as appelés?"`,
        examples:[
          "Tu as les clés? Oui, je LES ai. — Bạn có chìa khóa không? Có, tôi có.",
          "Ce film? Je L'ai vu hier. — Bộ phim đó? Tôi đã xem hôm qua.",
          "Elle cherche un plombier. Elle LE contacte. — Cô ấy tìm thợ sửa ống nước. Cô ấy liên hệ anh ta.",
          "Mange ta soupe! Mange-LA! — Ăn súp đi! Ăn đi!",
          "Ce livre? Je ne LE comprends pas. — Quyển sách đó? Tôi không hiểu.",
          "Vous avez vu Marie? — Oui, je L'ai vue ce matin. — Bạn có gặp Marie không? — Có, tôi đã gặp sáng nay.",
        ]
      },
    ]
  },
  {
    id:"g8", num:"8", title:"En forme!", points:[
      {
        topic:"Passé composé (2) — Participes passés irréguliers",
        rule:`Participes passés irréguliers PHẢI HỌC THUỘC! Đây là danh sách hay gặp nhất:

EN -U:
avoir→eu [y], boire→bu, courir→couru, croire→cru,
devoir→dû, falloir→fallu, lire→lu, pleuvoir→plu,
pouvoir→pu, recevoir→reçu, savoir→su, vivre→vécu,
vouloir→voulu, voir→vu, venir→venu

EN -IT/-IS:
dire→dit, écrire→écrit, faire→fait, mettre→mis,
prendre→pris, apprendre→appris, comprendre→compris,
permettre→permis, promettre→promis

EN -ERT:
couvrir→couvert, offrir→offert, ouvrir→ouvert, souffrir→souffert

EN -É (réguliers mais fréquents):
aller→allé (avec être!), naître→né, téléphoner→téléphone

COMPLÈTEMENT IRRÉGULIERS:
être→été, naître→né, mourir→mort

💡 Truco de memorización: groupez par terminaison!
-u: bu, lu, pu, su, vu, eu, eu!
-it: dit, fait, écrit
-is: mis, pris, appris`,
        examples:[
          "J'ai eu de la fièvre hier. — Hôm qua tôi bị sốt.",
          "Il a fait du sport ce matin. — Anh ấy đã tập thể thao sáng nay.",
          "Elle a pris rendez-vous chez le médecin. — Cô ấy đã hẹn gặp bác sĩ.",
          "Nous avons vu un bon film. — Chúng tôi đã xem một bộ phim hay.",
          "Tu as pu dormir? — Bạn đã ngủ được không?",
          "Ils n'ont pas voulu venir. — Họ đã không muốn đến.",
        ]
      },
      {
        topic:"Pronom Y — Remplace un complément de lieu",
        rule:`LE PRONOM Y = "đó / ở đó / đến đó"
Thay thế complément de lieu (à, en, dans, sur, chez... + lieu)

VỊ TRÍ: AVANT le verbe (comme les autres pronoms)
"Tu vas à la pharmacie?" → "Tu y vas?" (Y = à la pharmacie)
"Il est au bureau." → "Il y est." (Y = au bureau)
"Nous allons en France." → "Nous y allons." (Y = en France)

FORMES:
• Présent: J'y vais, Tu y vas, Il y va, Nous y allons...
• Futur proche: Je vais y aller. (y avant l'infinitif)
• Passé composé: J'y suis allé(e). (y avant l'auxiliaire)
• Impératif affirmatif: Vas-y! Allons-y! Allez-y!
• Impératif négatif: N'y va pas! N'y allons pas!

⚠️ Y ne remplace PAS les personnes (on utilise lui/leur):
"Je vais chez le médecin." → "J'y vais." ✅ (lieu)
"Je pense à ce problème." → "J'y pense." ✅ (chose)
"Je pense à ma mère." → "Je pense à elle." ❌ "J'y pense." (personne!)`,
        examples:[
          "Tu vas à la pharmacie? Oui, j'y vais maintenant. — Bạn đến nhà thuốc không? Có, tôi đi ngay.",
          "Il travaille au cabinet médical. Il y travaille depuis 5 ans. — Anh ấy làm ở phòng khám 5 năm rồi.",
          "On y va? — Chúng ta đi nhé? (đến đó)",
          "J'y suis allé(e) hier. — Tôi đã đến đó hôm qua.",
          "Allez-y! — Cứ tiến hành đi! / Cứ nói đi!",
          "N'y va pas, c'est dangereux. — Đừng đến đó, nguy hiểm.",
        ]
      },
      {
        topic:"Obligation personnelle — Devoir + infinitif",
        rule:`DEVOIR + INFINITIF = "phải làm gì" (obligation personnelle)

Chia DEVOIR au présent:
• Je dois      • Nous devons
• Tu dois      • Vous devez
• Il/Elle doit  • Ils/Elles doivent

Khác với IL FAUT (obligation générale, impersonnelle):
"Il faut manger des légumes." = Nói chung, người ta nên ăn rau.
"Tu DOIS manger des légumes." = Bạn (cụ thể) phải ăn rau.

PHỦ ĐỊNH → INTERDICTION (cấm):
"Tu ne dois PAS fumer." = Bạn không được hút thuốc.
"Il ne doit PAS conduire." = Anh ấy không được lái xe.

Các nghĩa khác của DEVOIR:
• Obligation: "Je dois partir." (tôi phải đi)
• Probabilité: "Il doit être là." (chắc anh ấy ở đó)
• Obligation morale: "Tu dois l'aider." (bạn nên giúp cô ấy)

DEVOIR au PASSÉ COMPOSÉ: "J'ai dû..." = tôi đã phải...
"J'ai dû prendre des médicaments." (Tôi đã phải uống thuốc)`,
        examples:[
          "Tu dois prendre ce médicament 3 fois par jour. — Bạn phải uống thuốc này 3 lần mỗi ngày.",
          "Vous devez vous reposer. — Bạn cần nghỉ ngơi.",
          "Il ne doit pas faire de sport cette semaine. — Anh ấy không được tập thể thao tuần này.",
          "Elle doit aller chez le médecin demain. — Cô ấy phải đến gặp bác sĩ ngày mai.",
          "Nous devons manger sainement. — Chúng ta phải ăn uống lành mạnh.",
          "J'ai dû annuler mon cours. — Tôi đã phải hủy bài học.",
        ]
      },
    ]
  },
  {
    id:"g9", num:"9", title:"Bonnes vacances!", points:[
      {
        topic:"Comparatifs — Plus, Aussi, Moins + adjectif + que",
        rule:`SO SÁNH trong tiếng Pháp — 3 mức độ:

SUPÉRIEUR (hơn): PLUS + adjectif + QUE
"Le train est plus rapide que le bus."

ÉGALITÉ (bằng nhau): AUSSI + adjectif + QUE
"Cet hôtel est aussi confortable que l'autre."

INFÉRIORITÉ (kém hơn): MOINS + adjectif + QUE
"Le camping est moins cher que l'hôtel."

⚠️ IRRÉGULIERS:
• BON → MEILLEUR (que): pas "plus bon"!
"Ce restaurant est meilleur que l'autre."
• MAUVAIS → PIRE (que) ou plus mauvais (informel)
• BIEN → MIEUX (adverbe, pas adjectif)

SO SÁNH VỚI NOM:
Plus de / Autant de / Moins de + nom + que
"Il y a plus de touristes en été qu'en hiver."

SO SÁNH VỚI VERBE:
Plus / Autant / Moins + que (pas d'adjectif)
"Je travaille plus que toi."
"Elle mange autant que son frère."

⚠️ QUE + pronom tonique: que moi, que toi, que lui, que nous...`,
        examples:[
          "Le TGV est plus rapide que la voiture. — Tàu cao tốc nhanh hơn ô tô.",
          "Cette plage est aussi belle que celle de Nice. — Bãi biển này đẹp như bãi ở Nice.",
          "Le camping est moins cher que l'hôtel, mais moins confortable. — Trại cắm trại rẻ hơn khách sạn nhưng kém tiện nghi hơn.",
          "Ce restaurant est meilleur que l'autre. — Nhà hàng này ngon hơn cái kia. (pas 'plus bon'!)",
          "Il y a plus de touristes en juillet qu'en mai. — Có nhiều khách du lịch hơn vào tháng 7 so với tháng 5.",
        ]
      },
      {
        topic:"Passé composé avec ÊTRE — Verbes de mouvement et d'état",
        rule:`Một số động từ dùng ÊTRE thay vì AVOIR ở passé composé!

DANH SÁCH PHẢI NHỚ (nhớ qua từ "DR & MRS VANT P" hoặc "la maison d'être"):
aller↔venir, partir↔arriver, entrer↔sortir,
monter↔descendre, naître↔mourir, rester, tomber,
passer, retourner, rentrer, devenir, revenir

⚠️ Với ÊTRE: PARTICIPE PASSÉ S'ACCORDE avec le SUJET!
• Masculin sg: Il est allé.
• Féminin sg: Elle est allée. (ajout de -E)
• Masculin pl: Ils sont allés. (ajout de -S)
• Féminin pl: Elles sont allées. (ajout de -ES)

⚠️ Verbes pronominaux → TOUJOURS avec ÊTRE:
"Je me suis levé(e)." "Il s'est habillé."

⚠️ ATTENTION: monter/descendre/sortir/rentrer/passer avec COD → AVOIR!
"Elle est montée." (sans COD, être)
"Elle a monté les bagages." (avec COD, avoir)`,
        examples:[
          "Je suis allé(e) à la plage hier. — Tôi đã đến bãi biển hôm qua.",
          "Elle est arrivée à 8h du matin. — Cô ấy đã đến lúc 8 giờ sáng.",
          "Ils sont partis tôt ce matin. — Họ đã khởi hành sớm sáng nay.",
          "Nous sommes restés une semaine. — Chúng tôi đã ở lại một tuần.",
          "Elle est née à Lyon. — Cô ấy sinh ở Lyon.",
          "Il est tombé en vacances et il est allé à l'hôpital. — Anh ấy bị ngã trong kỳ nghỉ và đã đến bệnh viện.",
        ]
      },
      {
        topic:"L'imparfait — C'était, Il y avait, Il faisait (description au passé)",
        rule:`L'IMPARFAIT dùng để MÔ TẢ ở quá khứ (trạng thái, hoàn cảnh, thói quen)

THÀNH LẬP: Radical de NOUS au présent + terminaisons
Terminaisons: -ais / -ais / -ait / -ions / -iez / -aient
ÊTRE (seule exception): j'étais, tu étais, il était...

Ba cụm từ cực kỳ hay dùng trong Édito A1:
• C'était + adjectif: "C'était magnifique! / C'était calme."
• Il y avait + nom: "Il y avait beaucoup de monde."
• Il faisait + temps: "Il faisait chaud/froid/beau/mauvais."

PHÂN BIỆT PASSÉ COMPOSÉ vs IMPARFAIT:
• Passé composé: hành động XẢY RA, CỤ THỂ
  "Je suis allé(e) à la plage." (tôi đã đi)
• Imparfait: HOÀN CẢNH, MÔ TẢ, THÓI QUEN
  "Il faisait beau, il y avait des touristes partout..."

Thường dùng CÙNG NHAU:
"Quand je suis arrivé(e) (PC), il faisait (IMP) très chaud."
(Khi tôi đến nơi, trời đang rất nóng.)`,
        examples:[
          "C'était magnifique! La mer était bleue et le sable blanc. — Thật tuyệt! Biển xanh và cát trắng.",
          "Il y avait beaucoup de touristes à la plage. — Có rất nhiều khách du lịch ở bãi biển.",
          "Il faisait très chaud, environ 35 degrés. — Trời rất nóng, khoảng 35 độ.",
          "Quand nous sommes arrivés, il pleuvait. — Khi chúng tôi đến nơi, trời đang mưa.",
          "L'hôtel était confortable et le personnel était sympa. — Khách sạn thoải mái và nhân viên thân thiện.",
        ]
      },
    ]
  },
  {
    id:"g10", num:"10", title:"Au travail!", points:[
      {
        topic:"Pronoms COD (2) — Me, Te, Nous, Vous",
        rule:`COD de 1re et 2e personnes — thay thế NGƯỜI trong câu:

• ME (m') = tôi (object): "Tu me comprends?"
• TE (t') = bạn (object): "Je te comprends."
• NOUS = chúng tôi (object): "Il nous aide."
• VOUS = các bạn / bạn (lịch sự) (object): "Je vous écoute."

VỊ TRÍ: AVANT le verbe (comme le/la/les)
"Il me téléphone souvent." (me avant le verbe)
"Je te comprends." (te avant le verbe)

DEVANT VOYELLE:
me → m': "Il m'appelle."
te → t': "Je t'écoute."

PHỦ ĐỊNH:
"Il ne me comprend pas." "Je ne te vois pas."

PASSÉ COMPOSÉ:
"Il m'a appelé." "Tu nous as compris?"
⚠️ Accord avec COD féminin: "Il m'a appelée." (si je = femme)

TEMPS COMPOSÉS + accord:
"Il vous a écoutés." (vous = hommes ou mixte)
"Il vous a écoutées." (vous = femmes seulement)`,
        examples:[
          "Tu me comprends? — Bạn hiểu tôi không?",
          "Il nous contacte par mail. — Anh ấy liên hệ chúng tôi qua email.",
          "Je t'écoute, continue! — Tôi đang nghe bạn, tiếp tục đi!",
          "Elle m'a appelé(e) ce matin. — Cô ấy đã gọi cho tôi sáng nay.",
          "Ils vous ont invités à la réunion? — Họ đã mời bạn đến cuộc họp chưa?",
          "Il ne me répond pas. — Anh ấy không trả lời tôi.",
        ]
      },
      {
        topic:"Pronoms relatifs — Qui et Que",
        rule:`PRONOMS RELATIFS nối hai câu, tránh lặp từ.

QUI = sujet (chủ ngữ) — suivi d'un VERBE
"J'ai un travail. Ce travail est intéressant."
→ "J'ai un travail QUI est intéressant."
(qui remplace "ce travail" = sujet de "est")

QUE/QU' = COD (bổ ngữ trực tiếp) — suivi d'un SUJET + VERBE
"J'ai des collègues. J'aime beaucoup ces collègues."
→ "J'ai des collègues QUE j'aime beaucoup."
(que remplace "ces collègues" = COD de "j'aime")

⚠️ QUE → QU' devant voyelle ou h muet:
"C'est un métier QU'il adore." "La collègue QU'elle cherche."

⚠️ OÙ = pronom relatif de lieu/temps:
"C'est le bureau OÙ je travaille." (lieu)
"C'est le jour OÙ je l'ai rencontré." (temps)

DONT = relatif de "de":
"C'est le projet DONT je parle." (parler DE qqch)
"C'est l'ami DONT je t'ai parlé." (parler DE qqn)`,
        examples:[
          "J'ai trouvé un emploi qui me plaît beaucoup. — Tôi đã tìm được công việc mà tôi rất thích.",
          "C'est un métier que j'adore. — Đây là nghề mà tôi rất yêu thích.",
          "La collègue qu'il cherche est en réunion. — Đồng nghiệp mà anh ấy tìm đang họp.",
          "C'est une entreprise qui offre de bonnes conditions. — Đây là công ty đưa ra điều kiện tốt.",
          "Le bureau où je travaille est très moderne. — Văn phòng nơi tôi làm việc rất hiện đại.",
          "Voilà le dossier dont tu as besoin. — Đây là hồ sơ mà bạn cần.",
        ]
      },
      {
        topic:"L'intensité — Un peu, Assez, Très, Beaucoup, Trop",
        rule:`Các trạng từ chỉ MỨC ĐỘ — thang tăng dần:

un peu (một chút) < assez (khá) < très (rất) < beaucoup (nhiều) < trop (quá)

RÈGLES D'EMPLOI:

TRÈS + adjectif/adverbe:
"Je suis très fatigué." "Elle parle très vite."
⚠️ Không nói "très beaucoup"!

BEAUCOUP + verbe (sans de):
"Je travaille beaucoup." "Il mange beaucoup."
Beaucoup de + nom: "Il a beaucoup DE travail."

UN PEU + adjectif/verbe:
"C'est un peu difficile." "Je mange un peu."
Un peu de + nom: "Un peu DE patience!"

ASSEZ + adjectif/verbe:
"Je suis assez fatigué." "Elle travaille assez."
Assez de + nom: "J'ai assez DE temps."

TROP → sens NÉGATIF (excès, problème):
"C'est trop cher!" "Je travaille trop."
Trop de + nom: "Il y a trop DE bruit."
⚠️ "Trop" n'est pas un compliment (sauf argot jeune: "c'est trop bien!")`,
        examples:[
          "Je suis très fatigué(e) parce que je travaille beaucoup. — Tôi rất mệt vì làm việc nhiều.",
          "Ce poste est assez intéressant mais un peu stressant. — Vị trí này khá thú vị nhưng hơi căng thẳng.",
          "Il parle trop vite, je ne comprends pas! — Anh ấy nói quá nhanh, tôi không hiểu!",
          "Elle a beaucoup d'expérience dans ce domaine. — Cô ấy có nhiều kinh nghiệm trong lĩnh vực này.",
          "Tu manges un peu trop de sucre. — Bạn ăn hơi nhiều đường đó.",
          "Il a très bien réussi son entretien. — Anh ấy đã vượt qua buổi phỏng vấn rất tốt.",
        ]
      },
    ]
  },
];


function GrammarPresets({ onLoad }) {
  const [open, setOpen] = useState(false);
  const [selectedUnit, setSelectedUnit] = useState(null);

  return (
    <div style={{ background:C.white, border:`1.5px solid ${C.purple}33`, borderRadius:12, overflow:"hidden", boxShadow:"0 1px 4px rgba(0,0,0,0.05)" }}>
      <button onClick={()=>{ setOpen(o=>!o); setSelectedUnit(null); }}
        style={{ width:"100%", display:"flex", justifyContent:"space-between", alignItems:"center", padding:"0.65rem 0.9rem", background:"transparent", border:"none", cursor:"pointer", fontFamily:"inherit" }}>
        <div style={{ display:"flex", alignItems:"center", gap:"0.5rem" }}>
          <span style={{ fontSize:"0.85rem" }}>📘</span>
          <div style={{ textAlign:"left" }}>
            <div style={{ fontSize:"0.78rem", fontWeight:600, color:C.purple }}>Ngữ pháp Édito A1 — theo unité</div>
            <div style={{ fontSize:"0.65rem", color:C.gray }}>11 unités · giải thích + ví dụ + bài tập</div>
          </div>
        </div>
        <span style={{ fontSize:"0.8rem", color:C.gray }}>{open?"▲":"▼"}</span>
      </button>

      {open && !selectedUnit && (
        <div style={{ borderTop:`1px solid ${C.border}`, padding:"0.6rem" }}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0.4rem" }}>
            {EDITO_GRAMMAR.map(u => (
              <button key={u.id} onClick={()=>setSelectedUnit(u)}
                style={{ background:C.cream, border:`1px solid ${C.border}`, borderRadius:8, padding:"0.55rem 0.6rem", textAlign:"left", cursor:"pointer", fontFamily:"inherit", transition:"all 0.15s" }}
                onMouseEnter={e=>e.currentTarget.style.background=C.purpleL}
                onMouseLeave={e=>e.currentTarget.style.background=C.cream}>
                <div style={{ display:"flex", gap:"0.35rem", alignItems:"center" }}>
                  <span style={{ background:C.purple, color:C.white, fontSize:"0.58rem", fontWeight:700, borderRadius:20, padding:"0.1rem 0.38rem", whiteSpace:"nowrap" }}>U{u.num}</span>
                  <div>
                    <div style={{ fontSize:"0.75rem", fontWeight:600, color:C.ink, lineHeight:1.2 }}>{u.title}</div>
                    <div style={{ fontSize:"0.62rem", color:C.gray }}>{u.points.length} điểm ngữ pháp</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {open && selectedUnit && (
        <div style={{ borderTop:`1px solid ${C.border}` }}>
          <button onClick={()=>setSelectedUnit(null)}
            style={{ display:"flex", alignItems:"center", gap:"0.4rem", padding:"0.5rem 0.9rem", background:"transparent", border:"none", cursor:"pointer", fontSize:"0.72rem", color:C.gray, fontFamily:"inherit" }}>
            ← Tất cả unités
          </button>
          <div style={{ padding:"0 0.75rem 0.75rem", display:"flex", flexDirection:"column", gap:"0.75rem" }}>
            {selectedUnit.points.map((p, i) => (
              <div key={i} style={{ background:C.white, border:`1.5px solid ${C.border}`, borderRadius:12, overflow:"hidden", boxShadow:"0 2px 8px rgba(91,79,207,0.07)" }}>
                {/* Header */}
                <div style={{ background:C.purpleL, padding:"0.55rem 0.75rem", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div style={{ fontSize:"0.78rem", fontWeight:600, color:C.purple, lineHeight:1.3 }}>{p.topic}</div>
                  <button onClick={()=>onLoad(p.topic)}
                    style={{ background:C.purple, color:C.white, border:"none", borderRadius:20, padding:"0.2rem 0.6rem", fontSize:"0.62rem", cursor:"pointer", whiteSpace:"nowrap", marginLeft:"0.5rem", flexShrink:0 }}>
                    Luyện tập →
                  </button>
                </div>
                {/* Rule */}
                <div style={{ padding:"0.65rem 0.85rem" }}>
                  <div style={{ fontSize:"0.73rem", color:C.ink, lineHeight:1.7, marginBottom:"0.65rem", background:C.cream, borderRadius:8, padding:"0.45rem 0.65rem", borderLeft:`3px solid ${C.purple}` }}>📌 {p.rule}</div>
                  <div style={{ fontSize:"0.63rem", textTransform:"uppercase", letterSpacing:0.8, color:C.gray, marginBottom:"0.4rem", fontWeight:600 }}>Ví dụ</div>
                  <div style={{ display:"flex", flexDirection:"column", gap:"0.55rem" }}>
                    {p.examples.map((ex, j) => {
                      const parts = ex.split(" — ");
                      const fr = parts[0] || ex;
                      const vi = parts[1] || "";
                      return (
                        <div key={j} style={{ background:C.white, border:`1px solid ${C.border}`, borderRadius:8, padding:"0.45rem 0.65rem" }}>
                          <div style={{ display:"flex", alignItems:"center", gap:"0.4rem", marginBottom: vi ? "0.25rem" : 0 }}>
                            <span style={{ fontSize:"0.65rem", color:C.purple, flexShrink:0 }}>▸</span>
                            <span style={{ fontFamily:"Georgia,serif", fontSize:"0.8rem", color:C.ink, fontStyle:"italic", flex:1 }}>{fr}</span>
                            <SpeakBtn text={fr} size="0.7rem" />
                          </div>
                          {vi && <div style={{ fontSize:"0.72rem", color:C.gray, marginLeft:"1.1rem", lineHeight:1.5 }}>→ {vi}</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function GrammarExplanation({ rules, text }) {
  // Prefer structured rules array; fall back to splitting plain text
  const items = rules && rules.length > 0 ? rules : (
    text ? text.split(/(?<=\S)\s+(?=\d+\.\s)|\n+/).filter(l => l.trim()).map(l => {
      if (/^⚠/.test(l.trim())) return { type: "warning", content: l.trim() };
      if (/^(Ngoại lệ|Lưu ý)/i.test(l.trim())) return { type: "note", content: l.trim() };
      return { type: "rule", content: l.trim() };
    }) : []
  );

  if (!items.length) return null;

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:"0.4rem" }}>
      {items.map((item, i) => {
        if (item.type === "warning") return (
          <div key={i} style={{ display:"flex", gap:"0.5rem", alignItems:"flex-start", background:"#fff8e6", border:"1px solid #f5c842", borderRadius:8, padding:"0.45rem 0.7rem" }}>
            <span style={{ fontSize:"0.9rem", flexShrink:0 }}>⚠️</span>
            <span style={{ fontSize:"0.78rem", color:"#7a5800", lineHeight:1.6 }}>{item.content.replace(/^⚠️?\s*/, "")}</span>
          </div>
        );
        if (item.type === "note") return (
          <div key={i} style={{ fontSize:"0.75rem", color:C.purple, lineHeight:1.6, padding:"0.35rem 0.65rem", background:C.purpleL, borderRadius:8, fontStyle:"italic" }}>
            {item.content}
          </div>
        );
        // type === "rule" — check if starts with number
        const numMatch = item.content.match(/^(\d+)\.\s*(.*)/s);
        if (numMatch) {
          const num = numMatch[1];
          const rest = numMatch[2];
          const colonIdx = rest.indexOf(":");
          const title = colonIdx > -1 ? rest.slice(0, colonIdx).trim() : rest;
          const detail = colonIdx > -1 ? rest.slice(colonIdx + 1).trim() : "";
          return (
            <div key={i} style={{ background:C.white, border:`1.5px solid ${C.border}`, borderRadius:10, overflow:"hidden" }}>
              <div style={{ background:C.purple, padding:"0.3rem 0.7rem", display:"flex", alignItems:"center", gap:"0.5rem" }}>
                <span style={{ background:C.white, color:C.purple, fontWeight:700, fontSize:"0.65rem", borderRadius:"50%", width:"1.2rem", height:"1.2rem", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>{num}</span>
                <span style={{ fontSize:"0.78rem", color:C.white, fontWeight:600, lineHeight:1.4 }}>{title}</span>
              </div>
              {detail && <div style={{ padding:"0.4rem 0.7rem", fontSize:"0.76rem", color:C.ink, lineHeight:1.7, fontFamily:"Georgia,serif", fontStyle:"italic" }}>{detail}</div>}
            </div>
          );
        }
        // Plain rule
        return (
          <div key={i} style={{ fontSize:"0.78rem", color:C.ink, lineHeight:1.7, padding:"0.1rem 0.1rem" }}>
            {item.content}
          </div>
        );
      })}
    </div>
  );
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
  const formRef = useRef(null);

  const generate = async (overrideTopic) => {
    const t = (overrideTopic !== undefined ? overrideTopic : topic).trim();
    if (!t) { setErr("Nhập chủ đề ngữ pháp!"); return; }
    setLoading(true); setErr(""); setResult(null); setWrongCount(0);
    try { setResult(await callAI(buildGrammarPrompt(t, level, gtype, numQ))); }
    catch(e) { setErr(e.message); }
    setLoading(false);
  };

  const handlePresetLoad = (t) => {
    setTopic(t);
    setLevel("A1");
    setResult(null);
    setTimeout(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      generate(t);
    }, 80);
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
      {/* Édito Presets */}
      <GrammarPresets onLoad={handlePresetLoad} />

      {/* Input form */}
      <div ref={formRef} style={{background:C.cream,borderRadius:12,padding:"0.9rem",display:"flex",flexDirection:"column",gap:"0.65rem"}}>
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
      {(result?.explanationRules?.length > 0 || result?.explanation) && (
        <div style={{background:C.purpleL,border:`1px solid #d4c5f5`,borderRadius:12,padding:"0.75rem 0.9rem"}}>
          <div style={{fontSize:"0.65rem",textTransform:"uppercase",letterSpacing:1,color:C.purple,marginBottom:"0.6rem",fontWeight:600}}>📖 Lý thuyết — {result.topic} · {result.level}</div>
          <GrammarExplanation rules={result.explanationRules} text={result.explanation} />
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

// ── Édito A1 Presets ────────────────────────────────────────
const EDITO_UNITS = [
  {
    id: "u0", num: "0", title: "Bienvenue !", theme: "Premiers contacts & classe",
    words: `bonjour — xin chào
bonsoir — chào buổi tối
salut — chào (thân mật)
au revoir — tạm biệt
à bientôt — hẹn gặp lại
à demain — hẹn ngày mai
ciao — tạm biệt (thân mật)
merci — cảm ơn
s'il vous plaît — làm ơn (lịch sự)
s'il te plaît — làm ơn (thân mật)
pardon — xin lỗi
excusez-moi — xin lỗi (lịch sự)
oui — có / vâng
non — không
ça va ? — bạn khỏe không?
ça va ! — khỏe!
très bien — rất tốt
bonne journée — chúc một ngày tốt lành
je ne comprends pas — tôi không hiểu
comment on dit… en français ? — người ta nói… bằng tiếng Pháp thế nào?
comment ça s'écrit ? — viết thế nào?
vous pouvez répéter ? — bạn có thể nhắc lại không?
je suis en retard — tôi đến muộn
je m'appelle — tôi tên là
et toi ? — còn bạn?
et vous ? — còn bạn? (lịch sự)
madame — bà / cô
monsieur — ông / thầy
lundi — thứ Hai
mardi — thứ Ba
mercredi — thứ Tư
jeudi — thứ Năm
vendredi — thứ Sáu
samedi — thứ Bảy
dimanche — Chủ Nhật
janvier — tháng Một
février — tháng Hai
mars — tháng Ba
avril — tháng Tư
mai — tháng Năm
juin — tháng Sáu
juillet — tháng Bảy
août — tháng Tám
septembre — tháng Chín
octobre — tháng Mười
novembre — tháng Mười Một
décembre — tháng Mười Hai
zéro — không
un — một
deux — hai
trois — ba
quatre — bốn
cinq — năm
six — sáu
sept — bảy
huit — tám
neuf — chín
dix — mười
onze — mười một
douze — mười hai
treize — mười ba
quatorze — mười bốn
quinze — mười lăm
seize — mười sáu
vingt — hai mươi
trente — ba mươi`
  },
  {
    id: "u1", num: "1", title: "Je suis…", theme: "Se présenter, nationalités, identité, nombres",
    words: `le nom — họ
le prénom — tên
la nationalité — quốc tịch
la date de naissance — ngày sinh
le lieu de naissance — nơi sinh
l'adresse mail — địa chỉ email
le compte Instagram — tài khoản Instagram
le numéro de téléphone — số điện thoại
le pays — đất nước
la ville — thành phố
s'appeler — tên là
habiter — sống / ở
parler — nói
avoir — có
être — là
j'ai … ans — tôi … tuổi
né(e) à — sinh tại (thành phố)
né(e) en — sinh tại (nước)
français(e) — người Pháp
allemand(e) — người Đức
espagnol(e) — người Tây Ban Nha
italien(ne) — người Ý
chinois(e) — người Trung Quốc
vietnamien(ne) — người Việt Nam
américain(e) — người Mỹ
japonais(e) — người Nhật
hollandais(e) — người Hà Lan
belge — người Bỉ
suisse — người Thụy Sĩ
russe — người Nga
coréen(ne) — người Hàn Quốc
marocain(e) — người Maroc
sénégalais(e) — người Sénégal
brésilien(ne) — người Brazil
algérien(ne) — người Algeria
tunisien(ne) — người Tunisia
mexicain(e) — người Mexico
argentin(e) — người Argentina
colombien(ne) — người Colombia
canadien(ne) — người Canada
polonais(e) — người Ba Lan
camerounais(e) — người Cameroon
indien(ne) — người Ấn Độ
tchèque — người Séc
l'art — nghệ thuật
le cinéma — điện ảnh
les langues — các ngôn ngữ
la musique — âm nhạc
le sport — thể thao
les loisirs — sở thích / thú vui
la bande dessinée — truyện tranh
le covoiturage — đi chung xe
trente-deux — ba mươi hai
quarante — bốn mươi
cinquante — năm mươi
soixante — sáu mươi
soixante-dix — bảy mươi
quatre-vingts — tám mươi
quatre-vingt-dix — chín mươi
cent — một trăm`
  },
  {
    id: "u2", num: "2", title: "Près de moi", theme: "Logement, famille, loisirs, professions",
    words: `l'appartement — căn hộ
la maison — ngôi nhà
le quartier — khu phố
la rue — con đường / phố
le centre-ville — trung tâm thành phố
la banlieue — vùng ngoại ô
la mer — biển
la plage — bãi biển
le jardin — vườn / công viên nhỏ
l'université — trường đại học
habiter — sống / ở
aimer — yêu thích
détester — ghét
adorer — rất yêu thích
préférer — thích hơn
la famille — gia đình
les parents — bố mẹ
le père — bố
la mère — mẹ
le frère — anh/em trai
la sœur — chị/em gái
les enfants — con cái
le mari — chồng
la femme — vợ
les grands-parents — ông bà
le grand-père — ông
la grand-mère — bà
l'oncle — chú/bác/cậu
la tante — dì/cô/bác gái
le cousin, la cousine — anh/chị/em họ
le neveu — cháu trai
la nièce — cháu gái
marié(e) — đã kết hôn
célibataire — độc thân
divorcé(e) — đã ly hôn
la situation familiale — tình trạng hôn nhân
la guitare — đàn guitar
le piano — đàn piano
la batterie — trống
l'instrument — nhạc cụ
le festival — lễ hội
le film — bộ phim
la danse, danser — khiêu vũ
la marche, marcher — đi bộ
la natation, nager — bơi lội
le ski, skier — trượt tuyết
la profession — nghề nghiệp
étudiant(e) — sinh viên
médecin — bác sĩ
professeur — giáo viên
acteur, actrice — diễn viên
chanteur, chanteuse — ca sĩ
infirmier, infirmière — y tá
architecte — kiến trúc sư
sympa — dễ mến / thân thiện
dynamique — năng động
calme — điềm tĩnh
les adjectifs possessifs — tính từ sở hữu
mon, ma, mes — của tôi
ton, ta, tes — của bạn
son, sa, ses — của anh/cô ấy`
  },
  {
    id: "u3", num: "3", title: "Qu'est-ce qu'on mange ?", theme: "Alimentation, commerces, restaurant",
    words: `la boulangerie — tiệm bánh mì
le boulanger, la boulangère — thợ làm bánh
la boucherie — tiệm thịt
le boucher, la bouchère — người bán thịt
l'épicerie — tiệm tạp hóa
l'épicier, l'épicière — người bán tạp hóa
la fromagerie — tiệm phô mai
le fromager, la fromagère — người bán phô mai
la poissonnerie — tiệm cá
le poissonnier, la poissonnière — người bán cá
le marché — chợ
le supermarché — siêu thị
la baguette — bánh mì que
le croissant — bánh sừng bò
le fromage — phô mai
le fromage de chèvre — phô mai dê
le beurre — bơ
la crème — kem tươi
le yaourt — sữa chua
les pâtes — mì ống
le riz — gạo / cơm
la farine — bột mì
l'huile d'olive — dầu ô liu
l'œuf — quả trứng
la pomme — táo
la tomate — cà chua
la fraise — dâu tây
la cerise — cherry
la pêche — đào
l'abricot — mơ
la courgette — bí xanh
les haricots verts — đậu cô ve
le poivron — ớt chuông
la pomme de terre — khoai tây
la salade — rau xà lách
le poulet — thịt gà
le poisson — cá
la viande — thịt
un kilo de — một kilô
une bouteille de — một chai
un paquet de — một gói
une boîte de — một hộp
un pot de — một lọ
un panier de — một giỏ
un peu de — một chút
beaucoup de — nhiều
pas de — không có
la carte bancaire — thẻ ngân hàng
les espèces — tiền mặt
payer — thanh toán
acheter — mua
Je voudrais — Tôi muốn
Combien ça coûte ? — Bao nhiêu tiền?
C'est à qui ? — Đến lượt ai?
Vous payez comment ? — Bạn thanh toán bằng gì?
commander — gọi món
l'addition — hóa đơn
le menu / la carte — thực đơn
le plat du jour — món trong ngày
l'entrée — món khai vị
le plat — món chính
le dessert — món tráng miệng
le sel — muối
le poivre — tiêu
le sucre — đường
le café — cà phê
le thé — trà
le jus de fruits — nước ép trái cây
l'eau — nước
le soda — nước ngọt có ga
la glace — kem
le gâteau — bánh ngọt
la tarte — bánh tart
l'omelette — trứng tráng
le steak-frites — bít tết kèm khoai tây chiên
choisir — chọn
finir — kết thúc / ăn hết`
  },
  {
    id: "u4", num: "4", title: "C'est où ?", theme: "Ville, lieux, transports, itinéraire, nombres",
    words: `l'avenue — đại lộ
le boulevard — đại lộ lớn
la place — quảng trường
le pont — cầu
le quai — bờ kè / bến tàu
la rue — con phố
le fleuve — sông lớn
le centre-ville — trung tâm thành phố
le quartier — khu phố
la banlieue — ngoại ô
les habitants — cư dân
les touristes — du khách
la banque — ngân hàng
le bâtiment — tòa nhà
la bibliothèque — thư viện
le commissariat — đồn cảnh sát
l'école — trường học
l'église — nhà thờ
la fontaine — đài phun nước
la gare — nhà ga
le jardin — vườn hoa
la mairie — tòa thị chính
le musée — bảo tàng
le parc — công viên
la poste — bưu điện
le théâtre — nhà hát
à pied — đi bộ
à vélo — đi xe đạp
à trottinette — đi xe trượt
en bus — bằng xe buýt
en métro — bằng tàu điện ngầm
en tramway — bằng xe điện
en voiture — bằng ô tô
en train — bằng tàu hỏa
le covoiturage — đi chung xe
les transports en commun — giao thông công cộng
l'arrêt — bến / trạm dừng
la carte de transport — thẻ giao thông
l'itinéraire — lộ trình
la ligne — tuyến đường
la station — ga / bến
le ticket — vé
prendre — đi / bắt (phương tiện)
tourner à gauche — rẽ trái
tourner à droite — rẽ phải
aller tout droit — đi thẳng
traverser — băng qua
continuer — tiếp tục
jamais — không bao giờ
souvent — thường xuyên
toujours — luôn luôn
pour — để / cho
parce que — bởi vì
mais — nhưng
avec — với
sans — không có
cent — một trăm
deux cents — hai trăm
mille — một nghìn
un million — một triệu
un milliard — một tỷ`
  },
  {
    id: "u5", num: "5", title: "C'est tendance !", theme: "Vêtements, couleurs, matières, météo, objets",
    words: `la chemise — áo sơ mi
le costume — bộ vest
le gilet — áo gile
l'imperméable — áo mưa
la jupe — chân váy
le manteau — áo khoác dài
le pantalon — quần dài
le jean — quần jeans
le pull — áo len
la robe — váy đầm
le short — quần short
le tee-shirt — áo thun
la veste — áo vest / áo khoác ngắn
les bijoux — đồ trang sức
la ceinture — thắt lưng
le chapeau — mũ
les chaussures — giày dép
la cravate — cà vạt
les lunettes de soleil — kính mát
le parapluie — ô / dù
blanc(he) — trắng
bleu(e) — xanh dương
gris(e) — xám
jaune — vàng
marron — nâu
noir(e) — đen
rose — hồng
rouge — đỏ
vert(e) — xanh lá
en coton — bằng vải cotton
en cuir — bằng da
en jean — bằng vải denim
en laine — bằng len
la taille — kích cỡ / số đo
la pointure — cỡ giày
la météo — thời tiết
le degré — độ (nhiệt độ)
la pluie — mưa
la neige — tuyết
le soleil — mặt trời / nắng
il fait chaud — trời nóng
il fait froid — trời lạnh
il pleut — trời mưa
il neige — trời có tuyết
le téléphone portable — điện thoại di động
l'ordinateur portable — máy tính xách tay
les écouteurs sans fil — tai nghe không dây
l'enceinte Bluetooth — loa Bluetooth
la montre connectée — đồng hồ thông minh
la tablette — máy tính bảng
le sac à dos — ba lô
le sac de sport — túi thể thao
la valise — vali
le porte-monnaie — ví tiền
le portefeuille — ví da
le cadre photo — khung ảnh
le porte-clés — móc chìa khóa
carré(e) — hình vuông
rond(e) — hình tròn
léger / légère — nhẹ
lourd(e) — nặng
vendre — bán
mettre — mặc / đặt
venir — đến`
  },
  {
    id: "u6", num: "6", title: "Qu'est-ce qu'on fait aujourd'hui ?", theme: "Routine, heure, sorties, description",
    words: `se brosser les dents — đánh răng
se coiffer — chải tóc
se coucher — đi ngủ
se doucher — tắm vòi
s'habiller — mặc quần áo
se lever — thức dậy
se maquiller — trang điểm
s'occuper des enfants — chăm sóc trẻ em
se préparer — chuẩn bị
se raser — cạo râu
se réveiller — thức dậy
prendre son petit déjeuner — ăn sáng
faire du bricolage — làm đồ thủ công
faire les courses — đi mua sắm
faire la cuisine — nấu ăn
faire du jardinage — làm vườn
faire une lessive — giặt đồ
faire le ménage — dọn dẹp nhà cửa
faire la vaisselle — rửa bát
aller à un concert — đi xem hòa nhạc
aller au théâtre — đi xem kịch
écouter de la musique — nghe nhạc
écouter la radio — nghe đài
faire du jogging — chạy bộ
faire du sport — tập thể thao
jouer à un jeu vidéo — chơi trò chơi điện tử
regarder la télévision — xem tivi
se promener — đi dạo
surfer sur Internet — lướt internet
voir des amis — gặp bạn bè
neuf heures — chín giờ
neuf heures cinq — chín giờ năm phút
neuf heures et quart — chín giờ mười lăm
neuf heures et demie — chín giờ rưỡi
dix heures moins le quart — mười giờ kém mười lăm
midi — buổi trưa / 12 giờ
minuit — nửa đêm
le matin — buổi sáng
l'après-midi — buổi chiều
le soir — buổi tối
parfois — đôi khi
rarement — hiếm khi
tous les jours — mỗi ngày
grand(e) — cao / to
petit(e) — nhỏ / thấp
gros(se) — béo
mince — gầy
la barbe — râu
la moustache — ria mép
les yeux bleus — mắt xanh
les yeux verts — mắt xanh lá
les yeux marron — mắt nâu
les cheveux blonds — tóc vàng
les cheveux bruns — tóc nâu
les cheveux roux — tóc đỏ
les cheveux courts — tóc ngắn
les cheveux longs — tóc dài
les cheveux frisés — tóc xoăn
les cheveux raides — tóc thẳng
être chauve — hói đầu
bavard(e) — hay nói
courageux / courageuse — dũng cảm
drôle — hài hước
dynamique — năng động
généreux / généreuse — hào phóng
pouvoir — có thể
vouloir — muốn
partir — rời đi
sortir — ra ngoài
dormir — ngủ
le passé récent — vừa mới (venir de + inf.)`
  },
  {
    id: "u7", num: "7", title: "Chez moi !", theme: "Logement, meubles, électroménager, règles",
    words: `l'appartement — căn hộ
la maison — ngôi nhà
déménager — dọn nhà
l'étage — tầng lầu
le rez-de-chaussée — tầng trệt
la fenêtre — cửa sổ
le jardin — vườn
la surface — diện tích
la terrasse — sân thượng / hiên
la chambre — phòng ngủ
la cuisine — phòng bếp
la salle à manger — phòng ăn
la salle de bains — phòng tắm
le salon — phòng khách
les toilettes — nhà vệ sinh
la pièce — căn phòng
l'armoire — tủ quần áo
le bureau — bàn làm việc
le canapé — ghế sofa
la chaise — ghế
le fauteuil — ghế bành
le lit — cái giường
la table basse — bàn thấp
la cuisinière — bếp nấu
le four — lò nướng
le four à micro-ondes — lò vi sóng
le lave-linge — máy giặt
le réfrigérateur / le frigo — tủ lạnh
l'ascenseur — thang máy
le balcon — ban công
le couloir — hành lang
l'escalier — cầu thang
le hall — sảnh vào
le local à poubelles — phòng rác
le local à vélos — bãi xe đạp
la pelouse — bãi cỏ
la porte d'entrée — cửa chính
la résidence — tòa chung cư
le/la voisin(e) — người hàng xóm
la fuite d'eau — rò rỉ nước
fonctionner — hoạt động / chạy
louer — thuê
trouver — tìm / thấy
il est interdit de — bị cấm
il faut — phải / cần
le règlement — quy định / nội quy
s'excuser — xin lỗi
expliquer — giải thích
le problème — vấn đề / sự cố
connaître — biết / quen biết
le pronom COD — đại từ bổ ngữ trực tiếp
le/la/l'/les (pronom) — nó / chúng (đại từ)`
  },
  {
    id: "u8", num: "8", title: "En forme !", theme: "Corps, santé, sport, émotions",
    words: `la tête — đầu
le bras — cánh tay
le dos — lưng
le genou — đầu gối
la gorge — cổ họng
la jambe — chân
la main — bàn tay
le pied — bàn chân
le ventre — bụng
la bouche — miệng
la dent — răng
l'œil / les yeux — mắt
l'oreille — tai
le nez — mũi
mesurer — đo chiều cao
peser — cân nặng
le mètre — mét
le kilo — kilô
la fièvre — sốt
la grippe — bệnh cúm
le rhume — cảm lạnh
tousser — ho
la toux — tiếng ho
malade — bệnh / ốm
l'hôpital — bệnh viện
la pharmacie — nhà thuốc
le médecin / le docteur — bác sĩ
le dentiste — nha sĩ
le pharmacien, la pharmacienne — dược sĩ
le médicament — thuốc
le paracétamol — paracetamol
le sirop — thuốc siro
la radio — phim X-quang
la vitamine C — vitamin C
la visite à domicile — khám tại nhà
l'activité physique — hoạt động thể chất
l'appareil de sport — dụng cụ thể thao
le certificat médical — giấy chứng nhận y tế
le coach — huấn luyện viên
la douche — vòi tắm
le maillot de bain — đồ bơi
le sauna — phòng tắm hơi
la serviette de bain — khăn tắm
le vestiaire — phòng thay đồ
l'alimentation saine — chế độ ăn lành mạnh
la calorie — calo
la corde à sauter — dây nhảy
la course à pied — chạy bộ
la gymnastique — thể dục
le judo — võ judo
la marche rapide — đi bộ nhanh
la musculation — tập tạ / gym
la natation — bơi lội
le rugby — bóng bầu dục
content(e) — vui / hài lòng
triste — buồn
fatigué(e) — mệt mỏi
stressé(e) — căng thẳng
heureux / heureuse — hạnh phúc
boire — uống
devoir — phải / cần phải
le conseil — lời khuyên
être d'accord — đồng ý
ne pas être d'accord — không đồng ý`
  },
  {
    id: "u9", num: "9", title: "Bonnes vacances !", theme: "Voyages, hébergement, nature, animaux",
    words: `la campagne — vùng quê
l'île — hòn đảo
la mer — biển
la montagne — núi
la plage — bãi biển
le village — làng
le camping — trại cắm trại
la chambre d'hôtes — nhà nghỉ tư gia
l'échange de maison — trao đổi nhà ở
la ferme — nông trại
l'hôtel — khách sạn
la location — nhà cho thuê
la tente — lều trại
l'arrivée — lúc đến
le départ — lúc khởi hành
la chambre simple — phòng đơn
la chambre double — phòng đôi
le parking — bãi đỗ xe
le petit déjeuner compris — bao gồm bữa sáng
réserver — đặt chỗ / đặt phòng
le champ — cánh đồng
le chemin — đường mòn
la forêt — rừng
le lac — hồ
la rivière — sông nhỏ
l'arbre — cái cây
la fleur — bông hoa
l'herbe — cỏ
la plante — cây cối
le canard — con vịt
le chat — con mèo
le cheval — con ngựa
le chien — con chó
le lapin — con thỏ
l'oiseau — con chim
le poisson — cá
la poule — con gà mái
la vache — con bò
faire du bateau — đi thuyền
faire de la plongée — lặn biển
pique-niquer — đi dã ngoại
le train — tàu hỏa
l'avion — máy bay
beau / belle — đẹp
magnifique — tuyệt đẹp
plus … que — hơn … (so sánh hơn)
aussi … que — cũng … như (so sánh ngang bằng)
la carte postale — bư�i thiếp
c'était — đó là (quá khứ)
il y avait — có (quá khứ)
il faisait beau — trời đẹp (quá khứ)
la destination — điểm đến
l'hébergement — chỗ ở
le moyen de transport — phương tiện di chuyển`
  },
  {
    id: "u10", num: "10", title: "Au travail !", theme: "Études, campus, vie professionnelle",
    words: `l'amphithéâtre / l'amphi — giảng đường lớn
la bibliothèque — thư viện
le logement étudiant — ký túc xá
le restaurant universitaire — căng tin đại học
la salle de cours — phòng học
le secrétariat — phòng hành chính
l'université — trường đại học
le cours — buổi học / môn học
le diplôme — bằng cấp
la licence — bằng cử nhân
l'enseignant(e) — giảng viên
le/la professeur(e) — thầy/cô giáo
les études — việc học
l'étudiant(e) — sinh viên
étudier — học
faire des études — theo học đại học
s'inscrire — đăng ký nhập học
la formation — khóa đào tạo
la note — điểm số
le commerce — thương mại
le droit — luật
l'économie — kinh tế
l'informatique — tin học
les langues — ngôn ngữ
les lettres — văn học
les mathématiques — toán học
les sciences — khoa học
le bureau — văn phòng
le contrat — hợp đồng
les horaires — giờ giấc làm việc
la machine à café — máy pha cà phê
la pause-déjeuner — giờ nghỉ trưa
le poste — vị trí / chức vụ
le restaurant d'entreprise — nhà ăn công ty
le salaire — lương
le télétravail — làm việc từ xa
l'agriculteur, l'agricultrice — nông dân
l'artiste — nghệ sĩ
le/la journaliste — nhà báo
le/la libraire — người bán sách
le/la photographe — nhiếp ảnh gia
le policier, la policière — cảnh sát
le chauffeur — tài xế
le comédien, la comédienne — diễn viên
le danseur, la danseuse — vũ công
communiquer — giao tiếp
écrire un mail — viết email
lire un rapport — đọc báo cáo
s'organiser — tổ chức công việc
préparer une réunion — chuẩn bị cuộc họp
travailler sur un dossier — làm hồ sơ
le mail / le courriel — email
l'ordinateur portable — máy tính xách tay
le smartphone — điện thoại thông minh
la visioconférence — họp trực tuyến
chercher un emploi — tìm việc làm
travailler — làm việc
les compétences — kỹ năng
le projet professionnel — dự án nghề nghiệp
la durée — thời gian / khoảng thời gian`
  },
];


function EditoPresets({ onLoad }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background:C.white, border:`1.5px solid ${C.gold}55`, borderRadius:12, overflow:"hidden" }}>
      <button onClick={()=>setOpen(o=>!o)}
        style={{ width:"100%", display:"flex", justifyContent:"space-between", alignItems:"center", padding:"0.65rem 0.9rem", background:"transparent", border:"none", cursor:"pointer", fontFamily:"inherit" }}>
        <div style={{ display:"flex", alignItems:"center", gap:"0.5rem" }}>
          <span style={{ fontSize:"0.85rem" }}>📘</span>
          <div style={{ textAlign:"left" }}>
            <div style={{ fontSize:"0.78rem", fontWeight:600, color:C.gold }}>Édito A1 — Từ vựng theo bài</div>
            <div style={{ fontSize:"0.65rem", color:C.gray }}>10 unités · nhấn 1 cái load ngay</div>
          </div>
        </div>
        <span style={{ fontSize:"0.8rem", color:C.gray }}>{open?"▲":"▼"}</span>
      </button>
      {open && (
        <div style={{ borderTop:`1px solid ${C.border}`, padding:"0.6rem" }}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0.4rem" }}>
            {EDITO_UNITS.map(u => (
              <button key={u.id} onClick={()=>{ onLoad(u); setOpen(false); }}
                style={{ background:C.cream, border:`1px solid ${C.border}`, borderRadius:8, padding:"0.55rem 0.6rem", textAlign:"left", cursor:"pointer", fontFamily:"inherit", transition:"all 0.15s" }}
                onMouseEnter={e=>e.currentTarget.style.background=C.purpleL}
                onMouseLeave={e=>e.currentTarget.style.background=C.cream}>
                <div style={{ display:"flex", gap:"0.35rem", alignItems:"center" }}>
                  <span style={{ background:C.gold, color:C.ink, fontSize:"0.58rem", fontWeight:700, borderRadius:20, padding:"0.1rem 0.38rem", whiteSpace:"nowrap" }}>U{u.num}</span>
                  <div>
                    <div style={{ fontSize:"0.75rem", fontWeight:600, color:C.ink, lineHeight:1.2 }}>{u.title}</div>
                    <div style={{ fontSize:"0.62rem", color:C.gray, marginTop:"0.08rem" }}>{u.words.split("\n").length} từ</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Défi du Jour Panel ─────────────────────────────────────
const DEFI_KEY = "defi_history";

function DefiPanel() {
  const [defi, setDefi] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const [score, setScore] = useState({ ok:0, total:0 });
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(DEFI_KEY) || "[]"); } catch { return []; }
  });

  const DEFI_TYPES = [
    "5 câu trắc nghiệm từ vựng Édito A1 ngẫu nhiên (chọn 1 trong 4 đáp án)",
    "5 câu điền từ vào chỗ trống về ngữ pháp A1 (mạo từ, giới từ, chia động từ être/avoir/aller)",
    "3 câu dịch câu ngắn từ tiếng Việt sang tiếng Pháp (A1 level)",
    "5 câu hỏi về văn hóa Pháp và Francophonie (trắc nghiệm)",
    "5 câu về từ vựng gia đình, nhà cửa, thức ăn (trắc nghiệm hoặc điền từ)",
  ];

  const today = new Date().toLocaleDateString("vi-VN");
  const todayDefi = history.find(h => h.date === today);

  const generate = async () => {
    setLoading(true); setErr(""); setDefi(null); setDone(false); setScore({ok:0,total:0});
    const type = DEFI_TYPES[Math.floor(Math.random() * DEFI_TYPES.length)];
    try {
      const r = await callAI(`French teacher for A1 Vietnamese learners. Create a daily challenge: ${type}.
CRITICAL: Every question MUST have both "q" and "answer" fields.
Return ONLY JSON:
{
  "title": "challenge title in French",
  "questions": [
    {
      "q": "question or Vietnamese sentence to translate",
      "options": ["A","B","C","D"],
      "answer": "correct answer or French translation (ALWAYS REQUIRED)",
      "explanation": "short tip in Vietnamese"
    }
  ]
}
Rules:
- Multiple choice: include "options" array with 4 items, "answer" = one of the options
- Fill blank: no "options", "q" has ___ for blank, "answer" = missing word
- Translate: no "options", "q" = Vietnamese sentence, "answer" = French translation`);
      setDefi(r);
    } catch(e) { setErr(e.message); }
    setLoading(false);
  };

  const finish = (ok, total) => {
    setDone(true);
    setScore({ok, total});
    markStudiedToday();
    const entry = { date: today, title: defi?.title, score: ok, total, pct: Math.round(ok/total*100) };
    const newH = [entry, ...history].slice(0, 30);
    setHistory(newH);
    localStorage.setItem(DEFI_KEY, JSON.stringify(newH));
  };

  const scoreColor = p => p >= 80 ? C.green : p >= 60 ? C.gold : C.red;
  const medal = p => p >= 80 ? "🥇" : p >= 60 ? "🥈" : "🥉";

  return (
    <div style={{ padding:"1rem", display:"flex", flexDirection:"column", gap:"0.85rem" }}>
      <div style={{ fontSize:"0.72rem", fontWeight:600, color:"#8e44ad" }}>🎲 Défi du Jour</div>
      <div style={{ fontSize:"0.73rem", color:C.gray, lineHeight:1.6 }}>Mỗi ngày một thử thách ngẫu nhiên — từ vựng, ngữ pháp, văn hóa. Làm xong tích streak!</div>

      {/* Today status */}
      {todayDefi && !defi && (
        <div style={{ background:"rgba(255,255,255,0.8)", border:`1.5px solid ${scoreColor(todayDefi.pct)}44`, borderRadius:12, padding:"0.9rem 1rem", display:"flex", alignItems:"center", gap:"0.8rem", boxShadow:"0 2px 8px rgba(0,0,0,0.05)" }}>
          <div style={{ fontSize:"2rem" }}>{medal(todayDefi.pct)}</div>
          <div>
            <div style={{ fontSize:"0.75rem", fontWeight:600, color:C.ink }}>Hôm nay đã làm!</div>
            <div style={{ fontSize:"0.7rem", color:C.gray, marginTop:"0.1rem" }}>{todayDefi.title} · {todayDefi.ok}/{todayDefi.total} đúng ({todayDefi.pct}%)</div>
          </div>
          <button onClick={generate} style={{ marginLeft:"auto", padding:"0.3rem 0.65rem", background:"transparent", border:`1px solid ${C.border}`, borderRadius:20, fontSize:"0.68rem", color:C.gray, cursor:"pointer" }}>Thêm 1 thử thách</button>
        </div>
      )}

      {/* Generate button */}
      {!defi && !loading && (
        <button onClick={generate}
          style={{ padding:"1rem", background:"linear-gradient(135deg, #8e44ad, #6b4fbb)", color:C.white, border:"none", borderRadius:14, fontFamily:"Georgia,serif", fontSize:"1rem", cursor:"pointer", boxShadow:"0 4px 16px rgba(142,68,173,0.3)" }}>
          🎲 {todayDefi ? "Thử thách mới" : "Bắt đầu thử thách hôm nay"}
        </button>
      )}

      {loading && <div style={{ display:"flex", flexDirection:"column", alignItems:"center", padding:"2rem", gap:"0.8rem" }}>
        <Spinner />
        <div style={{ fontSize:"0.8rem", color:C.gray }}>AI đang tạo thử thách...</div>
      </div>}

      {err && <div style={{ color:C.red, fontSize:"0.75rem", padding:"0.5rem", background:"#fde8e6", borderRadius:8 }}>⚠ {err}</div>}

      {/* Quiz */}
      {defi && !done && <DefiQuiz defi={defi} onFinish={finish} />}

      {/* Result */}
      {done && (
        <div style={{ background:"rgba(255,255,255,0.9)", border:`1.5px solid ${scoreColor(Math.round(score.ok/score.total*100))}44`, borderRadius:14, padding:"1.2rem", textAlign:"center", animation:"fadeUp 0.3s ease", boxShadow:"0 4px 16px rgba(0,0,0,0.06)" }}>
          <div style={{ fontSize:"2.5rem", marginBottom:"0.5rem" }}>{medal(Math.round(score.ok/score.total*100))}</div>
          <div style={{ fontFamily:"Georgia,serif", fontSize:"1.3rem", color: scoreColor(Math.round(score.ok/score.total*100)), marginBottom:"0.3rem" }}>
            {score.ok}/{score.total} đúng
          </div>
          <div style={{ fontSize:"0.78rem", color:C.gray, marginBottom:"1rem" }}>
            {score.ok === score.total ? "Hoàn hảo! Bạn thật xuất sắc 🌟" : score.ok >= score.total*0.8 ? "Rất tốt! Tiếp tục phát huy!" : score.ok >= score.total*0.6 ? "Khá tốt! Ôn lại nhé!" : "Cần ôn thêm — bạn làm được!"}
          </div>
          <button onClick={generate} style={{ padding:"0.6rem 1.2rem", background:"linear-gradient(135deg, #8e44ad, #6b4fbb)", color:C.white, border:"none", borderRadius:20, fontFamily:"Georgia,serif", fontSize:"0.85rem", cursor:"pointer" }}>
            🎲 Thử thách mới
          </button>
        </div>
      )}

      {/* History */}
      {history.length > 0 && !defi && (
        <div>
          <div style={{ fontSize:"0.65rem", textTransform:"uppercase", letterSpacing:1, color:C.gray, marginBottom:"0.5rem", fontWeight:600 }}>📅 Lịch sử thử thách</div>
          {history.slice(0,7).map((h,i) => (
            <div key={i} style={{ background:"rgba(255,255,255,0.75)", border:`1px solid ${C.border}`, borderRadius:8, padding:"0.5rem 0.75rem", marginBottom:"0.3rem", display:"flex", justifyContent:"space-between", alignItems:"center", boxShadow:"0 1px 4px rgba(0,0,0,0.04)" }}>
              <div>
                <div style={{ fontSize:"0.78rem", color:C.ink }}>{h.title || "Thử thách"}</div>
                <div style={{ fontSize:"0.65rem", color:C.gray, marginTop:"0.08rem" }}>{h.date}</div>
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:"0.3rem" }}>
                <span style={{ fontSize:"0.9rem" }}>{medal(h.pct)}</span>
                <span style={{ fontSize:"0.72rem", fontWeight:600, color: scoreColor(h.pct) }}>{h.pct}%</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DefiQuiz({ defi, onFinish }) {
  const [answers, setAnswers] = useState({});
  const [revealed, setRevealed] = useState({});
  const [inputVals, setInputVals] = useState({});
  const [grading, setGrading] = useState({});

  const questions = defi.questions || [];
  const allAnswered = questions.length > 0 && questions.every((_,i) => revealed[i]);

  useEffect(() => {
    if (!allAnswered) return;
    const ok = questions.filter((_,i) => {
      // For graded translate questions, use grading result
      if (grading[i] !== undefined) return grading[i];
      const ans = answers[i] || inputVals[i] || "";
      return ans.trim().toLowerCase() === (questions[i].answer||"").toLowerCase();
    }).length;
    const t = setTimeout(() => onFinish(ok, questions.length), 1000);
    return () => clearTimeout(t);
  }, [allAnswered]);

  const submitInput = async (i, q) => {
    const val = inputVals[i] || "";
    if (!val.trim()) return;
    // For translate questions, use simple AI-free check (flexible matching)
    if (!q.options) {
      const userLower = val.trim().toLowerCase().replace(/[''`.,!?]/g, "");
      const ansLower = (q.answer||"").toLowerCase().replace(/[''`.,!?]/g, "");
      // Check if key words match (at least 60% of answer words present)
      const ansWords = ansLower.split(" ").filter(w=>w.length>2);
      const matchCount = ansWords.filter(w => userLower.includes(w)).length;
      const isOk = ansWords.length === 0 ? userLower === ansLower : matchCount / ansWords.length >= 0.6;
      setGrading(g => ({...g, [i]: isOk}));
    }
    setRevealed(r => ({...r, [i]: true}));
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:"0.65rem", animation:"fadeUp 0.3s ease" }}>
      <div style={{ background:C.white, border:`1px solid ${C.border}`, borderRadius:12, padding:"0.7rem 0.9rem", boxShadow:"0 2px 8px rgba(0,0,0,0.05)" }}>
        <div style={{ fontFamily:"Georgia,serif", fontSize:"0.95rem", color:"#8e44ad" }}>🎲 {defi.title}</div>
        <div style={{ fontSize:"0.68rem", color:C.gray, marginTop:"0.15rem" }}>{questions.length} câu hỏi</div>
      </div>

      {questions.map((q, i) => {
        const isRevealed = revealed[i];
        const userAns = answers[i] || inputVals[i] || "";
        const correct = grading[i] !== undefined ? grading[i] :
          userAns.trim().toLowerCase() === (q.answer||"").toLowerCase();

        return (
          <div key={i} style={{ background:C.white, border:`1.5px solid ${isRevealed?(correct?C.green:C.red):C.border}`, borderRadius:12, padding:"0.85rem", boxShadow:"0 2px 8px rgba(0,0,0,0.04)" }}>
            <div style={{ fontSize:"0.63rem", color:C.gray, textTransform:"uppercase", letterSpacing:1, marginBottom:"0.35rem" }}>Câu {i+1}</div>
            <div style={{ fontFamily:"Georgia,serif", fontSize:"0.9rem", color:C.ink, marginBottom:"0.6rem", lineHeight:1.5 }}>{q.q}</div>

            {q.options && q.options.length > 0 ? (
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0.28rem" }}>
                {q.options.map((opt,j) => {
                  let bg=C.white, bc=C.border, col=C.ink;
                  if(isRevealed){
                    if(opt.toLowerCase()===(q.answer||"").toLowerCase()){bg="rgba(16,185,129,0.1)";bc=C.green;col=C.green;}
                    else if(opt===answers[i]){bg="rgba(239,68,68,0.1)";bc=C.red;col=C.red;}
                  } else if(answers[i]===opt){bg=C.purpleL;bc=C.purple;col=C.purple;}
                  return (
                    <button key={j} disabled={isRevealed}
                      onClick={()=>{ setAnswers(a=>({...a,[i]:opt})); setRevealed(r=>({...r,[i]:true})); }}
                      style={{padding:"0.45rem 0.6rem",border:`1.5px solid ${bc}`,borderRadius:10,background:bg,color:col,fontSize:"0.8rem",cursor:isRevealed?"default":"pointer",textAlign:"left",fontFamily:"inherit",transition:"all 0.15s"}}>
                      {opt}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div style={{ display:"flex", flexDirection:"column", gap:"0.4rem" }}>
                <div style={{ fontSize:"0.68rem", color:C.purple, marginBottom:"0.1rem" }}>
                  ✏️ Nhập câu tiếng Pháp
                </div>
                <div style={{ display:"flex", gap:"0.38rem" }}>
                  <input value={inputVals[i]||""} disabled={isRevealed}
                    onChange={e=>setInputVals(v=>({...v,[i]:e.target.value}))}
                    onKeyDown={e=>{ if(e.key==="Enter"&&!isRevealed) submitInput(i,q); }}
                    placeholder="Je suis…"
                    style={{flex:1,border:`1.5px solid ${isRevealed?(correct?C.green:C.red):C.border}`,borderRadius:10,padding:"0.5rem 0.7rem",fontSize:"0.88rem",fontFamily:"Georgia,serif",background:isRevealed?(correct?"rgba(16,185,129,0.08)":"rgba(239,68,68,0.08)"):C.white,color:isRevealed?(correct?C.green:C.red):C.ink,outline:"none"}}/>
                  {!isRevealed && (
                    <button onClick={()=>submitInput(i,q)}
                      style={{padding:"0.5rem 0.8rem",background:C.purple,color:C.white,border:"none",borderRadius:10,fontSize:"0.8rem",cursor:"pointer",whiteSpace:"nowrap",fontWeight:500}}>
                      OK
                    </button>
                  )}
                </div>
              </div>
            )}

            {isRevealed && (
              <div style={{ marginTop:"0.5rem", fontSize:"0.73rem", lineHeight:1.6, padding:"0.4rem 0.6rem", background:correct?"rgba(16,185,129,0.06)":"rgba(239,68,68,0.06)", borderRadius:8 }}>
                {correct
                  ? <div style={{ color:C.green, fontWeight:600 }}>✓ Chính xác!</div>
                  : <div style={{ color:C.red }}>✗ Đáp án gợi ý: <span style={{ fontFamily:"Georgia,serif", fontWeight:600 }}>{q.answer}</span></div>
                }
                {q.explanation && <div style={{ color:C.gray, marginTop:"0.2rem" }}>💡 {q.explanation}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Streak & Progress helpers ───────────────────────────────
const STREAK_KEY = "streak_data";
const PROGRESS_KEY = "module_progress";

function getStreak() {
  try {
    const d = JSON.parse(localStorage.getItem(STREAK_KEY) || "{}");
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now()-86400000).toDateString();
    if (d.last === today) return { streak: d.streak||1, studiedToday: true };
    if (d.last === yesterday) return { streak: d.streak||1, studiedToday: false };
    return { streak: 0, studiedToday: false };
  } catch { return { streak:0, studiedToday:false }; }
}

function markStudiedToday() {
  try {
    const d = JSON.parse(localStorage.getItem(STREAK_KEY) || "{}");
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now()-86400000).toDateString();
    if (d.last === today) return;
    const streak = d.last === yesterday ? (d.streak||1)+1 : 1;
    localStorage.setItem(STREAK_KEY, JSON.stringify({ last:today, streak }));
  } catch {}
}

function getProgress() {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}"); } catch { return {}; }
}

function markModuleUsed(moduleId) {
  try {
    const p = getProgress();
    if (!p[moduleId]) p[moduleId] = { count:0 };
    p[moduleId].count = (p[moduleId].count||0)+1;
    p[moduleId].last = new Date().toDateString();
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
    markStudiedToday();
  } catch {}
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
    <div style={{ minHeight:"100vh", background:C.paper, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"2rem 1.5rem" }}>
      <div style={{ fontFamily:"Georgia,serif", fontSize:"2.2rem", color:C.ink, marginBottom:"0.4rem" }}>Français</div>
      <div style={{ width:36, height:2, background:C.gold, marginBottom:"1.6rem" }} />
      <div style={{ background:C.white, border:`1px solid ${C.border}`, borderRadius:20, padding:"2rem 1.5rem", width:"100%", maxWidth:400, boxShadow:"0 4px 24px rgba(0,0,0,0.08)" }}>
        <div style={{ fontFamily:"Georgia,serif", color:C.ink, fontSize:"1rem", marginBottom:"0.4rem" }}>🔑 Nhập Anthropic API Key</div>
        <div style={{ fontSize:"0.75rem", color:C.gray, lineHeight:1.6, marginBottom:"1.2rem" }}>
          Lấy API key tại{" "}
          <a href="https://console.anthropic.com/keys" target="_blank" rel="noreferrer" style={{ color:C.purple }}>console.anthropic.com</a>
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
        <button onClick={save} style={{ width:"100%", padding:"0.8rem", background:C.purple, color:C.white, border:"none", borderRadius:12, fontFamily:"Georgia,serif", fontSize:"0.92rem", cursor:"pointer", fontWeight:600, boxShadow:"0 4px 12px rgba(91,79,207,0.3)" }}>
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
  const [section, setSection] = useState("home");
  const [onboarded, setOnboarded] = useState(() => !!localStorage.getItem("onboarded"));
  const [streakData, setStreakData] = useState(getStreak);
  const [progress, setProgress] = useState(getProgress);

  const goSection = (s, v) => {
    setSection(s); setView(v||s);
    markModuleUsed(s);
    setStreakData(getStreak());
    setProgress(getProgress());
  };

  const navBtn = (label, target, show=true) => show && (
    <button onClick={()=>setView(target)}
      style={{ padding:"0.22rem 0.58rem", background:view===target?C.purple:"transparent", border:`1px solid ${C.purple}`, color:view===target?C.white:C.purple, borderRadius:20, fontSize:"0.63rem", cursor:"pointer", fontWeight:view===target?600:400, whiteSpace:"nowrap" }}>
      {label}
    </button>
  );

  // ── Module definitions ──
  const MODULES = [
    { id:"vocab",       label:"Le Vocabulaire",     short:"Từ vựng",      icon:"📚", num:"01", color:C.gold,      view:"input",        tags:["Trắc nghiệm","Flashcard","Dictée"] },
    { id:"grammar",     label:"La Grammaire",       short:"Ngữ pháp",     icon:"🧩", num:"02", color:C.purple,    view:"grammar",      tags:["A1","A2","B1","B2"] },
    { id:"conjugaison", label:"La Conjugaison",     short:"Chia động từ", icon:"📖", num:"03", color:"#16a085",   view:"conjugaison",  tags:["être","avoir","aller","faire"] },
    { id:"conversation",label:"La Conversation",    short:"Hội thoại",    icon:"💬", num:"04", color:"#2980b9",   view:"conversation", tags:["Chào hỏi","Mua sắm","Quán cà phê"] },
    { id:"writing",     label:"L'Écriture",         short:"Viết câu",     icon:"✍️", num:"05", color:"#e67e22",   view:"writing",      tags:["Chấm điểm","Sửa lỗi"] },
    { id:"weakspots",   label:"Les Points Faibles", short:"Điểm yếu",     icon:"🎯", num:"06", color:C.red,       view:"weakspots",    tags:["Mạo từ","Giới từ","Chia động từ"] },
    { id:"analyse",     label:"L'Analyse",          short:"Phân tích",    icon:"🔍", num:"07", color:C.green,     view:"analyse",      tags:["Từ vựng","Ngữ pháp","Bản dịch"] },
    { id:"defi",        label:"Le Défi du Jour",    short:"Thử thách",    icon:"🎲", num:"08", color:"#8e44ad",   view:"defi",         tags:["Mỗi ngày","Mini-quiz","Bất ngờ"] },
  ];

  // Bottom tab items
  const TABS = [
    { id:"home",        icon:"🏠", label:"Trang chủ" },
    { id:"vocab",       icon:"📚", label:"Từ vựng" },
    { id:"defi",        icon:"🎲", label:"Thử thách" },
    { id:"conjugaison", icon:"📖", label:"Chia động từ" },
    { id:"more",        icon:"⋯",  label:"Thêm" },
  ];
  const [showMore, setShowMore] = useState(false);

  const SECTION_TITLE = { vocab:"Le Vocabulaire", grammar:"La Grammaire", conversation:"La Conversation", writing:"L'Écriture", weakspots:"Les Points Faibles", conjugaison:"La Conjugaison", analyse:"L'Analyse", defi:"Le Défi du Jour" };

  return (
    <div style={{ fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", background:C.paper, minHeight:"100vh", color:C.ink, paddingBottom: section!=="home" ? 60 : 0 }}>
      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
        @keyframes slideUp{from{opacity:0;transform:translateY(100%)}to{opacity:1;transform:translateY(0)}}
        * { -webkit-tap-highlight-color: transparent; }
      `}</style>

      {/* Toast */}
      {toast && <div style={{ position:"fixed", top:16, left:"50%", transform:"translateX(-50%)", background:C.ink, color:C.paper, padding:"0.5rem 1rem", borderRadius:20, fontSize:"0.8rem", zIndex:300, whiteSpace:"nowrap" }}>{toast}</div>}

      {/* Modals */}
      {showSave && <SaveModal text={text} onSave={handleSave} onClose={()=>setShowSave(false)} />}
      {showImport && <ImportModal onImport={t=>{setText(t);showToast("✓ Import thành công!");}} onClose={()=>setShowImport(false)} />}

      {/* More drawer */}
      {showMore && (
        <div style={{ position:"fixed", inset:0, zIndex:200 }} onClick={()=>setShowMore(false)}>
          <div style={{ position:"absolute", bottom:60, left:0, right:0, background:C.white, borderRadius:"20px 20px 0 0", padding:"1.2rem 1rem", boxShadow:"0 -8px 32px rgba(0,0,0,0.12)", animation:"slideUp 0.25s ease" }}
            onClick={e=>e.stopPropagation()}>
            <div style={{ width:36, height:4, background:C.border, borderRadius:2, margin:"0 auto 1rem" }} />
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0.6rem" }}>
              {[
                { id:"conversation", icon:"💬", label:"Hội thoại",  color:"#2980b9" },
                { id:"writing",      icon:"✍️", label:"Viết câu",   color:"#e67e22" },
                { id:"weakspots",    icon:"🎯", label:"Điểm yếu",   color:C.red },
                { id:"analyse",      icon:"🔍", label:"Phân tích",  color:C.green },
                { id:"grammar",      icon:"🧩", label:"Ngữ pháp",   color:C.purple },
              ].map(m => {
                const p = progress[m.id];
                return (
                  <button key={m.id} onClick={()=>{ setShowMore(false); goSection(m.id); }}
                    style={{ background:C.white, border:`1.5px solid ${C.border}`, borderRadius:14, padding:"0.85rem", textAlign:"left", cursor:"pointer", fontFamily:"inherit", boxShadow:"0 1px 4px rgba(0,0,0,0.05)" }}>
                    <div style={{ fontSize:"1.4rem", marginBottom:"0.3rem" }}>{m.icon}</div>
                    <div style={{ fontSize:"0.82rem", color:C.ink, fontWeight:600 }}>{m.label}</div>
                    {p && <div style={{ fontSize:"0.65rem", color:C.gray, marginTop:"0.15rem" }}>{p.count} lần dùng</div>}
                  </button>
                );
              })}
            </div>
            <button onClick={()=>{ setShowMore(false); onChangeKey(); }}
              style={{ marginTop:"0.8rem", width:"100%", padding:"0.55rem", background:"transparent", border:`1px solid ${C.border}`, borderRadius:8, color:C.gray, fontSize:"0.78rem", cursor:"pointer" }}>
              🔑 Đổi API key
            </button>
          </div>
        </div>
      )}

      {/* ── ONBOARDING ── */}
      {!onboarded && section==="home" && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.7)", zIndex:250, display:"flex", alignItems:"flex-end", justifyContent:"center" }}>
          <div style={{ background:C.white, borderRadius:"20px 20px 0 0", padding:"1.5rem 1.25rem 2rem", width:"100%", maxWidth:480, animation:"slideUp 0.3s ease" }}>
            <div style={{ fontFamily:"Georgia,serif", fontSize:"1.3rem", color:C.ink, marginBottom:"0.4rem" }}>Bắt đầu từ đây 👋</div>
            <div style={{ fontSize:"0.8rem", color:C.gray, lineHeight:1.7, marginBottom:"1.2rem" }}>
              App có 7 module học tiếng Pháp. Nếu bạn đang học <b>Edito A1</b>, mình gợi ý thứ tự này:
            </div>
            {[
              { icon:"📚", step:"1", text:"Le Vocabulaire — nhập từ bài học, luyện flashcard" },
              { icon:"📖", step:"2", text:"La Conjugaison — tra bảng chia động từ ngay khi cần" },
              { icon:"✍️", step:"3", text:"L'Écriture — viết câu, AI sửa lỗi cho bạn" },
              { icon:"💬", step:"4", text:"La Conversation — roleplay tình huống thực tế" },
            ].map((s,i) => (
              <div key={i} style={{ display:"flex", gap:"0.75rem", alignItems:"flex-start", marginBottom:"0.65rem" }}>
                <div style={{ width:26, height:26, background:C.purple, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:"0.65rem", color:C.white, fontWeight:700, flexShrink:0 }}>{s.step}</div>
                <div style={{ fontSize:"0.8rem", color:C.ink, lineHeight:1.5 }}><span style={{ marginRight:"0.3rem" }}>{s.icon}</span>{s.text}</div>
              </div>
            ))}
            <button onClick={()=>{ localStorage.setItem("onboarded","1"); setOnboarded(true); }}
              style={{ marginTop:"0.8rem", width:"100%", padding:"0.85rem", background:C.purple, color:C.white, border:"none", borderRadius:12, fontFamily:"Georgia,serif", fontSize:"1rem", cursor:"pointer" }}>
              Bắt đầu học ✦
            </button>
          </div>
        </div>
      )}

      {/* ── HOMEPAGE ── */}
      {section==="home" && (
        <div style={{ minHeight:"100vh", background:C.paper, display:"flex", flexDirection:"column" }}>
          {/* Hero */}
          <div style={{ padding:"3rem 1.25rem 1.5rem", textAlign:"center" }}>
            <div style={{ fontSize:"0.68rem", color:C.purple, letterSpacing:"0.18em", textTransform:"uppercase", marginBottom:"0.5rem", fontWeight:600 }}>BIENVENUE</div>
            <div style={{ fontFamily:"Georgia,serif", fontSize:"2.2rem", color:C.ink, lineHeight:1.1, fontWeight:700 }}>Français</div>
            <div style={{ width:40, height:3, background:C.purple, borderRadius:2, margin:"0.7rem auto" }} />

            {/* Streak banner */}
            <div style={{ display:"inline-flex", alignItems:"center", gap:"0.5rem", background:C.white, border:`1.5px solid ${C.border}`, borderRadius:24, padding:"0.4rem 1rem", marginTop:"0.5rem", boxShadow:"0 2px 12px rgba(0,0,0,0.08)" }}>
              <span style={{ fontSize:"1rem" }}>{streakData.streak > 0 ? "🔥" : "📅"}</span>
              <span style={{ fontSize:"0.78rem", color: streakData.streak > 0 ? C.gold : C.gray }}>
                {streakData.streak > 0 ? `${streakData.streak} ngày liên tiếp` : "Chưa học hôm nay"}
              </span>
              {streakData.studiedToday && <span style={{ fontSize:"0.65rem", background:C.green, color:C.white, borderRadius:20, padding:"0.1rem 0.4rem" }}>✓ Hôm nay</span>}
            </div>
          </div>

          {/* Module grid */}
          <div style={{ padding:"0.5rem 1rem 1.5rem", display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0.75rem", flex:1 }}>
            {MODULES.map(m => {
              const p = progress[m.id];
              const used = p?.count > 0;
              return (
                <button key={m.id} onClick={()=>goSection(m.id, m.view)}
                  style={{ background:C.white, border:`1.5px solid ${C.border}`, borderRadius:18, padding:"1.1rem 1rem", textAlign:"left", cursor:"pointer", fontFamily:"inherit", transition:"all 0.2s", position:"relative", boxShadow:"0 1px 4px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04)" }}
                  onMouseEnter={e=>{ e.currentTarget.style.boxShadow=`0 4px 20px rgba(0,0,0,0.1)`; e.currentTarget.style.transform="translateY(-2px)"; e.currentTarget.style.borderColor=m.color; }}
                  onMouseLeave={e=>{ e.currentTarget.style.boxShadow="0 1px 4px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04)"; e.currentTarget.style.transform="translateY(0)"; e.currentTarget.style.borderColor=C.border; }}>
                  {/* Used badge */}
                  {used && <div style={{ position:"absolute", top:8, right:8, width:8, height:8, borderRadius:"50%", background:m.color, opacity:0.8 }} />}
                  <div style={{ fontSize:"1.6rem", marginBottom:"0.5rem" }}>{m.icon}</div>
                  <div style={{ display:"inline-block", fontSize:"0.58rem", color:m.color, background:m.color+"18", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:"0.35rem", fontWeight:700, padding:"0.12rem 0.45rem", borderRadius:20 }}>Module {m.num}</div>
                  <div style={{ fontFamily:"Georgia,serif", fontSize:"1rem", color:C.ink, lineHeight:1.2, marginBottom:"0.3rem", fontWeight:600 }}>{m.label}</div>
                  <div style={{ display:"flex", gap:"0.25rem", flexWrap:"wrap" }}>{m.tags.slice(0,2).map((t,i)=><span key={i} style={{ fontSize:"0.62rem", color:C.gray, background:C.cream, padding:"0.1rem 0.4rem", borderRadius:20, border:`1px solid ${C.border}` }}>{t}</span>)}</div>
                  {used && <div style={{ fontSize:"0.62rem", color:m.color, marginTop:"0.3rem", opacity:0.7 }}>{p.count} lần dùng</div>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── APP SHELL ── */}
      {section!=="home" && (
        <>
          {/* Header */}
          <div style={{ background:C.white, color:C.ink, padding:"0.75rem 1rem", display:"flex", alignItems:"center", gap:"0.5rem", borderBottom:`1px solid ${C.border}`, position:"sticky", top:0, zIndex:100, boxShadow:"0 1px 0 ${C.border}" }}>
            <button onClick={()=>setSection("home")} style={{ background:C.cream, border:`1px solid ${C.border}`, color:C.ink, cursor:"pointer", fontSize:"0.85rem", padding:"0.25rem 0.55rem", lineHeight:1, borderRadius:8, fontWeight:500 }}>← Về</button>
            <span style={{ fontFamily:"Georgia,serif", fontSize:"1rem", marginRight:"auto" }}>
              {SECTION_TITLE[section] || section}
            </span>

            {section==="vocab" && <div style={{ display:"flex", gap:"0.3rem", flexWrap:"wrap" }}>
              {navBtn("✏️","input")}
              {navBtn("📂","history")}
              {navBtn("📊","stats")}
              {generatedVocab.length>0 && navBtn("📋","vocab-table")}
              {words.length>0 && navBtn("💬","examples")}
              {(quiz||loading) && navBtn("🎯","quiz")}
            </div>}
            {section==="grammar" && navBtn("🧩 Bài tập","grammar")}
            {section==="conjugaison" && navBtn("📖 Conjugaison","conjugaison")}
            {section==="conversation" && navBtn("💬 Hội thoại","conversation")}
            {section==="writing" && navBtn("✍️ Viết câu","writing")}
            {section==="weakspots" && navBtn("🎯 Điểm yếu","weakspots")}
            {section==="analyse" && navBtn("🔍 Phân tích","analyse")}
            {section==="defi" && navBtn("🎲 Thử thách","defi")}
          </div>

          {/* Content */}
          <div style={{ minHeight:"calc(100vh - 116px)", background:C.paper }}>
            {/* ── INPUT ── */}
            {view==="input" && (
              <div style={{ background:C.paper, padding:"1rem", display:"flex", flexDirection:"column", gap:"0.75rem" }}>
                <EditoPresets onLoad={u => { setText(u.words); showToast(`✓ Đã load ${u.title}!`); }} />
                <VocabGenerator onGenerate={generated => {
                  const lines = generated.map(w => `${w.fr} — ${w.vi}`).join("\n");
                  setText(lines); setView("vocab-table"); setGeneratedVocab(generated);
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
                  style={{ width:"100%", height:145, border:`1.5px solid ${C.border}`, borderRadius:8, padding:"0.58rem", fontFamily:"inherit", fontSize:"0.85rem", background:C.white, resize:"vertical", color:C.ink, lineHeight:1.6, outline:"none", boxSizing:"border-box" }} />
                <div style={{ fontSize:"0.7rem", color:C.gray }}>
                  Mỗi dòng: <code style={{ background:C.border, padding:"1px 4px", borderRadius:3 }}>từ pháp — nghĩa</code>
                  {words.length>0 && <span style={{ color:C.purple, marginLeft:6 }}>{words.length} từ</span>}
                </div>
                {words.length>0 && <div style={{ display:"flex", flexWrap:"wrap", gap:"0.25rem" }}>
                  {words.slice(0,8).map((w,i)=><span key={i} style={{ background:C.white, border:`1px solid ${C.border}`, borderRadius:20, padding:"0.09rem 0.44rem", fontSize:"0.7rem", color:C.purple }}>{w.fr}</span>)}
                  {words.length>8 && <span style={{ background:C.white, border:`1px solid ${C.border}`, borderRadius:20, padding:"0.09rem 0.44rem", fontSize:"0.7rem", color:C.gray }}>+{words.length-8}</span>}
                </div>}
                <div>
                  <div style={{ fontSize:"0.72rem", fontWeight:600, color:C.purple, marginBottom:"0.35rem" }}>🎯 Dạng bài tập</div>
                  <div style={{ fontSize:"0.68rem", color:C.gray, textTransform:"uppercase", letterSpacing:1, marginBottom:"0.28rem" }}>Chọn đáp án</div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0.28rem", marginBottom:"0.5rem" }}>
                    {[{id:"multiple_choice",label:"☑ Trắc nghiệm"},{id:"matching",label:"🔗 Nối từ"},{id:"flashcard",label:"🃏 Flashcard"},{id:"mixed",label:"🎲 Hỗn hợp"}].map(t=>(
                      <button key={t.id} onClick={()=>setType(t.id)} style={{ padding:"0.42rem 0.3rem", border:`1.5px solid ${type===t.id?C.purple:C.border}`, borderRadius:8, background:type===t.id?C.purple:C.white, color:type===t.id?C.white:C.ink, fontSize:"0.78rem", cursor:"pointer", fontFamily:"inherit", transition:"all 0.15s" }}>{t.label}</button>
                    ))}
                  </div>
                  <div style={{ fontSize:"0.68rem", color:C.gray, textTransform:"uppercase", letterSpacing:1, marginBottom:"0.28rem" }}>Điền / Viết từ</div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"0.28rem" }}>
                    {[{id:"fill_blank",label:"✏️ Điền từ"},{id:"dictee",label:"🎧 Dictée"},{id:"anagramme",label:"🔀 Anagramme"}].map(t=>(
                      <button key={t.id} onClick={()=>setType(t.id)} style={{ padding:"0.42rem 0.3rem", border:`1.5px solid ${type===t.id?C.purple:C.border}`, borderRadius:8, background:type===t.id?C.purple:C.white, color:type===t.id?C.white:C.ink, fontSize:"0.78rem", cursor:"pointer", fontFamily:"inherit", transition:"all 0.15s" }}>{t.label}</button>
                    ))}
                  </div>
                </div>
                {!["matching","dictee","flashcard","anagramme"].includes(type) && (
                  <div>
                    <div style={{ fontSize:"0.72rem", fontWeight:600, color:C.purple, marginBottom:"0.35rem" }}>🔢 Số câu hỏi</div>
                    <div style={{ display:"flex", alignItems:"center", gap:"0.5rem" }}>
                      <input type="range" min={3} max={30} value={numQ} onChange={e=>setNumQ(Number(e.target.value))} style={{ flex:1, accentColor:C.purple }} />
                      <div style={{ minWidth:32, textAlign:"center", fontFamily:"Georgia,serif", fontSize:"1rem", color:C.purple, fontWeight:600 }}>{numQ}</div>
                    </div>
                    {numQ>words.length && words.length>0 && <div style={{ fontSize:"0.7rem", color:C.gold, marginTop:"0.2rem" }}>💡 AI sẽ dùng lại từ theo nhiều cách</div>}
                  </div>
                )}
                {error && <div style={{ color:C.red, fontSize:"0.78rem", padding:"0.38rem 0.58rem", background:"#fde8e6", borderRadius:6 }}>⚠ {error}</div>}
                <button onClick={generate} disabled={loading||words.length<2}
                  style={{ width:"100%", padding:"0.8rem", background:words.length<2?C.border:C.purple, color:C.white, border:"none", borderRadius:12, fontFamily:"Georgia,serif", fontSize:"0.93rem", cursor:words.length<2?"not-allowed":"pointer", fontWeight:600, boxShadow:words.length>=2?"0 4px 12px rgba(91,79,207,0.3)":"none" }}>
                  {loading?"Đang tạo...":"Tạo bài tập ✦"}
                </button>
              </div>
            )}

            {/* ── HISTORY ── */}
            {view==="history" && (
              <div style={{ padding:"1rem", background:C.paper, minHeight:"100%" }}>
                <div style={{ fontSize:"0.75rem", fontWeight:600, color:C.purple, marginBottom:"0.7rem" }}>📂 Bộ từ đã lưu</div>
                {sets.length===0
                  ? <div style={{ textAlign:"center", color:C.gray, fontSize:"0.88rem", padding:"2rem", lineHeight:1.8 }}>Chưa có bộ từ nào.<br/>Nhập từ vựng và nhấn 💾 Lưu!</div>
                  : sets.map(s=>(
                    <div key={s.id} style={{ background:C.white, border:`1.5px solid ${C.border}`, borderRadius:12, padding:"0.8rem 1rem", marginBottom:"0.55rem" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                        <div>
                          <div style={{ fontFamily:"Georgia,serif", fontSize:"0.95rem", color:C.ink, marginBottom:"0.2rem" }}>{s.name}</div>
                          <div style={{ fontSize:"0.72rem", color:C.gray }}>{s.count} từ · {s.date}</div>
                        </div>
                        <div style={{ display:"flex", gap:"0.35rem" }}>
                          <button onClick={()=>{setText(s.text);setView("input");showToast("✓ Đã load!");}}
                            style={{ padding:"0.28rem 0.65rem", background:C.purple, color:C.white, border:"none", borderRadius:6, fontSize:"0.72rem", cursor:"pointer" }}>Ôn lại</button>
                          <button onClick={async()=>{const u=sets.filter(x=>x.id!==s.id);setSets(u);await saveSets(u);}}
                            style={{ padding:"0.28rem 0.5rem", background:"transparent", color:C.gray, border:`1px solid ${C.border}`, borderRadius:6, fontSize:"0.72rem", cursor:"pointer" }}>🗑</button>
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
                    <div style={{ fontFamily:"Georgia,serif", fontSize:"0.85rem" }}>{e.word}</div>
                    {vi && <div style={{ fontSize:"0.67rem", color:C.gray }}>{vi}</div>}
                    <div style={{ display:"flex", gap:"0.4rem", alignItems:"center", marginTop:"0.28rem" }}>
                      <div style={{ flex:1, height:3, background:C.border, borderRadius:2 }}>
                        <div style={{ height:"100%", width:`${e.rate}%`, background:isWeak?(e.rate>=50?C.gold:C.red):C.green, borderRadius:2 }} />
                      </div>
                      <span style={{ fontSize:"0.65rem", color:isWeak?C.red:C.green, fontWeight:600, minWidth:28 }}>{e.rate}%</span>
                    </div>
                  </div>
                );
              };
              return (
                <div style={{ padding:"1rem" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.75rem" }}>
                    <div style={{ fontSize:"0.75rem", fontWeight:600, color:C.purple }}>📊 Thống kê</div>
                    <div style={{ display:"flex", gap:"0.4rem" }}>
                      {weakWords.length>0 && <button onClick={()=>{setText(weakWords.join("\n"));setQuiz(null);setView("input");showToast("✓ Đã load từ yếu!");}} style={{ padding:"0.22rem 0.65rem", background:C.purple, color:C.white, border:"none", borderRadius:20, fontSize:"0.65rem", cursor:"pointer" }}>🎯 Ôn từ yếu ({weak.length})</button>}
                      {entries.length>0 && <button onClick={()=>{setStats({});showToast("✓ Đã xóa");}} style={{ padding:"0.22rem 0.55rem", background:"transparent", color:C.gray, border:`1px solid ${C.border}`, borderRadius:20, fontSize:"0.65rem", cursor:"pointer" }}>🗑</button>}
                    </div>
                  </div>
                  {entries.length===0
                    ? <div style={{ textAlign:"center", color:C.gray, fontSize:"0.88rem", padding:"3rem 1rem", lineHeight:1.8 }}>Chưa có dữ liệu.<br/>Làm bài tập để bắt đầu theo dõi!</div>
                    : <>
                        <div style={{ display:"flex", gap:"0.5rem", marginBottom:"0.85rem" }}>
                          {[{label:"Tổng từ",val:entries.length,color:C.purple},{label:"Từ yếu",val:weak.length,color:C.red},{label:"Thành thạo",val:mastered.length,color:C.green}].map((item,i)=>(
                            <div key={i} style={{ flex:1, background:C.white, border:`1.5px solid ${C.border}`, borderRadius:10, padding:"0.5rem 0.3rem", textAlign:"center" }}>
                              <div style={{ fontFamily:"Georgia,serif", fontSize:"1.2rem", color:item.color, fontWeight:600 }}>{item.val}</div>
                              <div style={{ fontSize:"0.65rem", color:C.gray }}>{item.label}</div>
                            </div>
                          ))}
                        </div>
                        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0.75rem" }}>
                          <div>
                            <div style={{ fontSize:"0.65rem", textTransform:"uppercase", letterSpacing:1, color:C.red, marginBottom:"0.4rem", fontWeight:600 }}>✗ Từ yếu ({weak.length})</div>
                            {weak.length===0?<div style={{ fontSize:"0.78rem", color:C.gray, fontStyle:"italic" }}>Không có 🎉</div>:weak.map((e,i)=><WordPill key={i} e={e} isWeak={true}/>)}
                          </div>
                          <div>
                            <div style={{ fontSize:"0.65rem", textTransform:"uppercase", letterSpacing:1, color:C.green, marginBottom:"0.4rem", fontWeight:600 }}>✓ Thành thạo ({mastered.length})</div>
                            {mastered.length===0?<div style={{ fontSize:"0.78rem", color:C.gray, fontStyle:"italic" }}>Chưa có</div>:mastered.map((e,i)=><WordPill key={i} e={e} isWeak={false}/>)}
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
                  <div style={{ fontFamily:"Georgia,serif", fontSize:"1rem", color:C.purple }}>✨ {generatedVocab.length} từ vựng</div>
                  <button onClick={()=>setView("input")} style={{ padding:"0.22rem 0.65rem", background:C.purple, color:C.white, border:"none", borderRadius:20, fontSize:"0.65rem", cursor:"pointer" }}>📝 Luyện tập →</button>
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1.2fr 1fr 0.8fr 1.6fr", gap:"0.3rem", marginBottom:"0.3rem", padding:"0.4rem 0.6rem" }}>
                  {["Giống đực","Giống cái","Nghĩa","Ví dụ"].map((h,i)=>(
                    <div key={i} style={{ fontSize:"0.62rem", textTransform:"uppercase", letterSpacing:1, color:C.gray, fontWeight:600 }}>{h}</div>
                  ))}
                </div>
                {generatedVocab.map((w, i) => (
                  <div key={i} style={{ display:"grid", gridTemplateColumns:"1.2fr 1fr 0.8fr 1.6fr", gap:"0.3rem", background:i%2===0?C.white:C.cream, borderRadius:8, padding:"0.55rem 0.6rem", marginBottom:"0.25rem", alignItems:"start" }}>
                    <div>
                      <div style={{ fontFamily:"Georgia,serif", fontSize:"0.88rem", color:C.ink, fontWeight:600, display:"flex", alignItems:"center", gap:"0.2rem" }}>{w.fr} <SpeakBtn text={w.fr} /></div>
                      {w.gender && <div style={{ fontSize:"0.65rem", color:C.purple, fontStyle:"italic" }}>{w.gender}</div>}
                    </div>
                    <div>
                      {w.fr_f ? <><div style={{ fontFamily:"Georgia,serif", fontSize:"0.88rem", color:C.purple }}>{w.fr_f}</div><div style={{ fontSize:"0.65rem", color:C.purple, fontStyle:"italic" }}>f.</div></> : <div style={{ fontSize:"0.72rem", color:C.border, fontStyle:"italic" }}>—</div>}
                    </div>
                    <div style={{ fontSize:"0.8rem", color:C.ink }}>{w.vi}</div>
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
                <div style={{ fontSize:"0.75rem", fontWeight:600, color:C.purple, marginBottom:"0.7rem" }}>💬 Tạo câu ví dụ & phân tích</div>
                {words.map((w,i)=><ExampleCard key={i} word={w}/>)}
              </div>
            )}
            {/* ── QUIZ ── */}
            {view==="quiz" && (
              <div style={{ padding:"1rem" }}>
                {loading
                  ? <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:200, gap:"0.7rem", color:C.gray }}><Spinner/><span style={{ fontSize:"0.85rem" }}>AI đang tạo bài tập...</span></div>
                  : quiz ? <>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.8rem", flexWrap:"wrap", gap:"0.4rem" }}>
                        <span style={{ background:C.purple, color:C.white, fontSize:"0.62rem", padding:"0.16rem 0.52rem", borderRadius:20, textTransform:"uppercase", letterSpacing:0.5 }}>{TYPE_NAMES[quiz.type]||quiz.type}</span>
                        <div style={{ display:"flex", gap:"0.4rem", flexWrap:"wrap" }}>
                          {hasFill && <button onClick={()=>exportFillPDF(quiz)} style={{ padding:"0.23rem 0.6rem", border:`1.5px solid ${C.purple}`, borderRadius:20, background:C.white, color:C.purple, fontSize:"0.68rem", cursor:"pointer" }}>📄 PDF</button>}
                          {!CLIENT_TYPES.includes(quiz.type) && <button onClick={addMoreQuestions} disabled={loading} style={{ padding:"0.23rem 0.6rem", border:`1.5px solid ${C.green}`, borderRadius:20, background:C.white, color:C.green, fontSize:"0.68rem", cursor:"pointer" }}>➕ Thêm</button>}
                          {wrongAnswers.length>0 && !CLIENT_TYPES.includes(quiz.type) && <button onClick={retryWrong} disabled={loading} style={{ padding:"0.23rem 0.6rem", border:`1.5px solid ${C.red}`, borderRadius:20, background:C.white, color:C.red, fontSize:"0.68rem", cursor:"pointer" }}>🔁 Ôn sai ({wrongAnswers.length})</button>}
                          <button onClick={()=>{setWrongAnswers([]);generate();}} style={{ padding:"0.23rem 0.6rem", border:`1.5px solid ${C.border}`, borderRadius:20, background:C.white, color:C.ink, fontSize:"0.68rem", cursor:"pointer" }}>🔄</button>
                        </div>
                      </div>
                      {renderQuiz()}
                    </> : null
                }
              </div>
            )}
            {/* ── OTHER PANELS ── */}
            {view==="defi" && <DefiPanel />}
            {view==="conjugaison" && <ConjugaisonPanel />}
            {view==="writing" && <WritingPanel />}
            {view==="weakspots" && <WeakSpotsPanel />}
            {view==="conversation" && <ConversationPanel />}
          </div>

          {/* ── BOTTOM TAB BAR ── */}
          <div style={{ position:"fixed", bottom:0, left:0, right:0, background:C.white, borderTop:`1.5px solid ${C.border}`, display:"flex", zIndex:150, boxShadow:"0 -4px 16px rgba(0,0,0,0.06)" }}>
            {TABS.map(tab => {
              const isActive = tab.id==="home" ? section==="home" : tab.id==="more" ? showMore : section===tab.id;
              return (
                <button key={tab.id} onClick={()=>{
                  if (tab.id==="more") { setShowMore(s=>!s); return; }
                  setShowMore(false);
                  if (tab.id==="home") { setSection("home"); return; }
                  const m = MODULES.find(m=>m.id===tab.id);
                  if (m) goSection(m.id, m.view);
                }}
                  style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"0.5rem 0.25rem 0.6rem", background:"transparent", border:"none", cursor:"pointer", gap:"0.15rem" }}>
                  <span style={{ fontSize:"1.2rem", lineHeight:1 }}>{tab.icon}</span>
                  <span style={{ fontSize:"0.58rem", color: isActive ? C.purple : C.gray, fontWeight: isActive ? 700 : 400, letterSpacing:0.2 }}>{tab.label}</span>
                  {isActive && <div style={{ width:18, height:2, background:C.purple, borderRadius:1, marginTop:1 }} />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}


