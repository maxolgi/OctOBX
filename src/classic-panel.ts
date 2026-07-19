/*
 * classic-panel.ts — Full Octopus control surface, faithful port of web_gui.html.
 * Generates the same DOM structure with the same element IDs so MIR rendering
 * maps are identical. Replaces WebSocket with direct WASM calls.
 */

import type { OctopusWasmModule } from "./octopus-types";

const MIR_SIZE = 170;

const CLASSIC_CSS = `
.octo-classic-root{background:#1a1a1a;display:flex;align-items:center;justify-content:center;position:fixed;inset:0;overflow:hidden;font-family:monospace;user-select:none}
.octo-classic-root .panel{--lbl:#777;background:#F8F6F0;border-radius:0;padding:0;box-shadow:none;display:flex;flex-direction:column;gap:8px;border:none}
.octo-classic-root .top-sec{display:flex;gap:8px}
.octo-classic-root .grid-row{display:flex;gap:2px;align-items:center}
.octo-classic-root .left-sec{display:flex;flex-direction:column;gap:17px;padding-top:24px}
.octo-classic-root .circle{position:relative;width:540px;height:500px;flex-shrink:0;align-self:flex-start}
.octo-classic-root .right-sec{display:flex;gap:6px;align-items:flex-start}
.octo-classic-root .spacer-20{width:20px}.octo-classic-root .spacer-34{width:34px}.octo-classic-root .spacer-36{width:36px}.octo-classic-root .spacer-140{width:140px}
.octo-classic-root .mix-row{display:flex;gap:2px;align-items:flex-end;padding:4px 0 3px 0}
.octo-classic-root .tnum{display:flex;align-items:center;justify-content:center;font-size:8px;color:var(--lbl);width:14px;flex-shrink:0;margin-top:8px;height:22px;margin-right:-20px}
.octo-classic-root .bcell{display:flex;flex-direction:column;align-items:center;gap:1px}
.octo-classic-root .led{width:7px;height:7px;border-radius:50%;background:transparent;transition:background .05s,box-shadow .05s;pointer-events:none;flex-shrink:0}
.octo-classic-root .sbtn{border-radius:50%;background:radial-gradient(circle at 35% 30%,#f0f0f0,#b8b8b8 70%,#a0a0a0);border:1px solid #888;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:inset 0 1px 2px rgba(255,255,255,.6),0 1px 1px rgba(0,0,0,.2);color:#444}
.octo-classic-root .sbtn:active{transform:scale(.92)}
.octo-classic-root .sbtn.held,.octo-classic-root .rbtn.held,.octo-classic-root .zm-btn.held,.octo-classic-root .mxp.held,.octo-classic-root .big-knob.held{transform:scale(.92)}
.octo-classic-root .attr-wrap{position:relative;height:30px;width:22px}
.octo-classic-root .attr-btn{width:22px;height:22px;flex-shrink:0;margin-top:8px}
.octo-classic-root .attr-led{position:absolute;left:25px;top:19px;transform:translateY(-50%)}
.octo-classic-root .attr-lbl{font-size:8px;color:var(--lbl);white-space:nowrap;position:absolute;right:25px;top:19px;transform:translateY(-50%)}
.octo-classic-root .mut-wrap{position:relative;height:30px;width:22px}
.octo-classic-root .mut-btn{width:22px;height:22px;flex-shrink:0;margin-top:8px}
.octo-classic-root .mut-led{position:absolute;right:25px;top:19px;transform:translateY(-50%)}
.octo-classic-root .mut-lbl{font-size:8px;color:var(--lbl);white-space:nowrap;position:absolute;left:25px;top:19px;transform:translateY(-50%)}
.octo-classic-root .pad-btn{width:22px;height:22px;touch-action:none}
.octo-classic-root .rot-entry{display:flex;flex-direction:column;align-items:center;gap:1px;padding-top:8px;width:45px}
.octo-classic-root .rot-entry-right{position:relative}
.octo-classic-root .rot-pair{display:flex;gap:1px}
.octo-classic-root .rb{width:22px;height:22px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#f0f0f0,#b8b8b8 70%,#a0a0a0);border:1px solid #888;cursor:pointer;font-size:8px;color:#333;display:flex;align-items:center;justify-content:center;box-shadow:inset 0 1px 2px rgba(255,255,255,.6),0 1px 1px rgba(0,0,0,.2)}
.octo-classic-root .rb:active{background:linear-gradient(to bottom,#b0b0b0,#909090)}
.octo-classic-root .rot-lbl-right{font-size:8px;color:var(--lbl);white-space:nowrap;position:absolute;left:35px;top:19px;transform:translateY(-50%)}
.octo-classic-root .knob{width:22px;height:22px;position:relative;cursor:ns-resize;flex-shrink:0}
.octo-classic-root .knob:active{cursor:grabbing}
.octo-classic-root .knob-cap{position:absolute;inset:-3px;clip-path:polygon(50% 0%,93% 25%,93% 75%,50% 100%,7% 75%,7% 25%);background:linear-gradient(150deg,#ececec,#c4c4c4 40%,#a8a8a8 55%,#c0c0c0 75%,#d8d8d8);filter:drop-shadow(0 1px 1px rgba(0,0,0,.4));transition:transform .06s linear}
.octo-classic-root .knob-indicator{display:none}
.octo-classic-root .mmix{display:flex;flex-direction:column;align-items:center;gap:1px}
.octo-classic-root .mmix-wide{width:45px;flex-shrink:0}
.octo-classic-root .empty-cell{width:22px;flex-shrink:0}
.octo-classic-root .mmix .rbtn{width:22px;height:22px}
.octo-classic-root .mmix .rlbl{font-size:8px;color:var(--lbl);line-height:1}
.octo-classic-root .plbl{position:absolute;font-size:8px;color:var(--lbl);letter-spacing:1px;text-transform:uppercase;pointer-events:none;z-index:0}
.octo-classic-root .rbtn-wrap{position:absolute;display:flex;flex-direction:column;align-items:center;gap:1px;z-index:1}
.octo-classic-root .rbtn{width:24px;height:24px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#f0f0f0,#b8b8b8 70%,#a0a0a0);border:1px solid #888;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:inset 0 1px 2px rgba(255,255,255,.6),0 1px 1px rgba(0,0,0,.2)}
.octo-classic-root .rbtn:active{transform:scale(.92)}
.octo-classic-root .rlbl{font-size:8px;color:var(--lbl);line-height:1}
`;

const keyNames: Record<string, number> = {MIX:21,SEL:32,ATR:43,VOL:54,PAN:65,MOD:76,EXP:87,U0:98,U1:109,U2:120,U3:131,U4:142,U5:153,MUT:164,EDT:175,ESC:186,TGGL:187,SOLO:188,CLR:189,RND:190,FLT:191,RMX:192,EFF:193,ZOOM:194,CPY:195,PST:196,VEL:1,PIT:2,LEN:3,STR:4,POS:5,DIR:6,AMT:7,GRV:8,MCC:9,MCH:10,BK1:201,BK2:200,BK3:199,BK4:198,BK5:197,BK6:207,BK7:206,BK8:216,BK9:215,BK100:224,BK200:233,CH1:205,CH2:204,CH3:203,CH4:202,CHN:213,FLW:214,MY:243,PEN:244,WHL:245,MAJ:246,MIN:247,DIM:248,CHR:249,SSEL:222,SMOD:221,CAD:230,PGM:242,TPO:234,REC:223,STP:231,PSE:232,P1:241,P2:240,P4:250,GRID:218,PAGE:219,TRK:220,STEP:227,MAP:228,PLAY:229,C:212,"C#":211,D:210,"D#":209,E:208,F:217,"F#":225,G:226,"G#":235,A:236,"A#":237,B:238,CUP:239,ALN:251,CHORD0:258,CHORD1:257,CHORD2:256,CHORD3:255,CHORD4:254,CHORD5:253,CHORD6:252};
const mkey = (r: number, c: number) => 11 + c * 11 + r;

export function buildClassicPanel(module: OctopusWasmModule): () => void {
    const root = document.getElementById("view-classic")!;
    root.className = "octo-classic-root";

    const style = document.createElement("style");
    style.textContent = CLASSIC_CSS;
    document.head.appendChild(style);

    const skey = (i: number, p: number | boolean) => module._wasm_key_press(i, p ? 1 : 0);
    const rrot = (i: number, d: number) => module._wasm_rotary(i, d);

    function setTip(el: HTMLElement, text: string) { el.dataset.tip = text; }

    function mkCell(btn: HTMLElement): HTMLElement {
        const led = document.createElement("div"); led.className = "led";
        const cell = document.createElement("div"); cell.className = "bcell";
        cell.appendChild(led); cell.appendChild(btn);
        return cell;
    }

    let knobDrag: { el: HTMLElement; y: number; acc: number; t: (d: number) => void } | null = null;

    function createKnob(idx: number): HTMLElement {
        const k = document.createElement("div"); k.className = "knob";
        const cap = document.createElement("div"); cap.className = "knob-cap";
        k.appendChild(cap);
        let rot = 0;
        function tick(d: number) { rrot(idx, d); rot += d === 2 ? 20 : -20; cap.style.transform = `rotate(${rot}deg)`; }
        k.addEventListener("wheel", (e) => { e.preventDefault(); tick(e.deltaY < 0 ? 2 : 1); }, { passive: false });
        k.addEventListener("mousedown", (e) => { e.preventDefault(); knobDrag = { el: k, y: e.clientY, acc: 0, t: tick }; k.style.cursor = "grabbing"; });
        return k;
    }

    const mouseMoveHandler = (e: MouseEvent) => {
        if (!knobDrag) return;
        const dy = knobDrag.y - e.clientY;
        while (dy - knobDrag.acc >= 10) { knobDrag.acc += 10; knobDrag.t(2); }
        while (dy - knobDrag.acc <= -10) { knobDrag.acc -= 10; knobDrag.t(1); }
    };
    const mouseUpHandler = () => { if (knobDrag) { knobDrag.el.style.cursor = ""; knobDrag = null; } };
    document.addEventListener("mousemove", mouseMoveHandler);
    document.addEventListener("mouseup", mouseUpHandler);

    const heldKeys = new Map<number, HTMLElement>();
    let dragPaint: { visited: Set<string> } | null = null;

    function bindKey(el: HTMLElement, key: number) {
        if (!el) return;
        el.oncontextmenu = (e) => { e.preventDefault(); return false; };
        el.onmousedown = (e) => {
            if (e.ctrlKey || e.metaKey || e.button === 2) {
                e.preventDefault();
                if (heldKeys.has(key)) { skey(key, false); el.classList.remove("held"); heldKeys.delete(key); }
                else { skey(key, true); el.classList.add("held"); heldKeys.set(key, el); }
                return;
            }
            skey(key, true);
        };
        el.onmouseup = () => {
            if (heldKeys.has(key)) return;
            skey(key, false);
            heldKeys.forEach((heldEl, k) => { skey(k, false); heldEl.classList.remove("held"); });
            heldKeys.clear();
        };
    }

    function bindStepPad(el: HTMLElement, key: number) {
        if (!el) return;
        el.oncontextmenu = (e) => { e.preventDefault(); return false; };
        el.onmousedown = (e) => {
            if (e.ctrlKey || e.metaKey || e.button === 2) {
                e.preventDefault();
                if (heldKeys.has(key)) { skey(key, false); el.classList.remove("held"); heldKeys.delete(key); }
                else { skey(key, true); el.classList.add("held"); heldKeys.set(key, el); }
                return;
            }
            e.preventDefault();
            dragPaint = { visited: new Set() };
            skey(key, true); skey(key, false);
            dragPaint.visited.add(el.id);
        };
        el.addEventListener("mouseenter", () => {
            if (!dragPaint || dragPaint.visited.has(el.id)) return;
            skey(key, true); skey(key, false);
            dragPaint.visited.add(el.id);
        });
        el.onmouseup = () => {
            if (heldKeys.has(key)) return;
            dragPaint = null;
            heldKeys.forEach((heldEl, k) => { skey(k, false); heldEl.classList.remove("held"); });
            heldKeys.clear();
        };
        el.addEventListener("touchstart", (e) => {
            e.preventDefault();
            dragPaint = { visited: new Set() };
            skey(key, true); skey(key, false);
            dragPaint.visited.add(el.id);
        }, { passive: false });
        el.addEventListener("touchmove", (e) => {
            if (!dragPaint) return;
            e.preventDefault();
            const t = e.touches[0];
            const tgt = document.elementFromPoint(t.clientX, t.clientY);
            const pad = tgt ? tgt.closest(".pad-btn") as HTMLElement | null : null;
            if (pad && pad.id.match(/^p\d+_\d+$/) && !dragPaint.visited.has(pad.id)) {
                const m = pad.id.match(/^p(\d+)_(\d+)$/)!;
                const pk = mkey(+m[1], +m[2]);
                skey(pk, true); skey(pk, false);
                dragPaint.visited.add(pad.id);
            }
        }, { passive: false });
    }

    const mouseUpClear = () => { dragPaint = null; };
    document.addEventListener("mouseup", mouseUpClear);

    const attrLabels = ["VEL", "PIT", "LEN", "STR", "POS", "DIR", "AMT", "GRV", "MCC", "MCH"];
    const mutLabels = ["TGGL", "SOLO", "CLR", "RND", "FLT", "RMX", "EFF", "ZOOM", "CPY", "PST"];

    root.innerHTML = "";

    const panel = document.createElement("div"); panel.className = "panel"; panel.id = "panel";
    const topSec = document.createElement("div"); topSec.className = "top-sec"; topSec.id = "topSec";
    const leftSec = document.createElement("div"); leftSec.className = "left-sec"; leftSec.id = "leftSec";
    const circle = document.createElement("div"); circle.className = "circle"; circle.id = "circle";
    topSec.appendChild(leftSec); topSec.appendChild(circle);
    panel.appendChild(topSec);
    root.appendChild(panel);

    for (let row = 0; row <= 9; row++) {
        const r = document.createElement("div"); r.className = "grid-row";
        r.appendChild(Object.assign(document.createElement("div"), { className: "tnum", textContent: String(row) }));
        const lr = document.createElement("div"); lr.className = "rot-entry";
        lr.appendChild(createKnob(20 - row));
        r.appendChild(Object.assign(document.createElement("div"), { className: "spacer-20" }));
        r.appendChild(lr);
        r.appendChild(Object.assign(document.createElement("div"), { className: "spacer-20" }));
        const aw = document.createElement("div"); aw.className = "attr-wrap";
        const aLbl = document.createElement("div"); aLbl.className = "attr-lbl"; aLbl.textContent = attrLabels[row];
        const aLed = document.createElement("div"); aLed.className = "led attr-led";
        const abtn = document.createElement("div"); abtn.className = "sbtn attr-btn"; abtn.id = `lbt-${row + 1}`;
        aw.appendChild(aLbl); aw.appendChild(aLed); aw.appendChild(abtn);
        r.appendChild(aw);
        r.appendChild(Object.assign(document.createElement("div"), { className: "spacer-20" }));
        for (let col = 0; col < 16; col++) {
            const p = document.createElement("div"); p.className = "sbtn pad-btn"; p.id = `p${row}_${col}`;
            r.appendChild(mkCell(p));
        }
        r.appendChild(Object.assign(document.createElement("div"), { className: "spacer-20" }));
        const mw = document.createElement("div"); mw.className = "mut-wrap";
        const mLbl = document.createElement("div"); mLbl.className = "mut-lbl"; mLbl.textContent = mutLabels[row];
        const mLed = document.createElement("div"); mLed.className = "led mut-led";
        const mt = document.createElement("div"); mt.className = "sbtn mut-btn"; mt.id = `rbt-${187 + row}`;
        mw.appendChild(mLbl); mw.appendChild(mLed); mw.appendChild(mt);
        r.appendChild(mw);
        r.appendChild(Object.assign(document.createElement("div"), { className: "spacer-20" }));
        const rr = document.createElement("div"); rr.className = "rot-entry rot-entry-right";
        rr.appendChild(createKnob(row + 1));
        const rrLbl = document.createElement("span"); rrLbl.className = "rot-lbl-right"; rrLbl.textContent = attrLabels[row];
        rr.appendChild(rrLbl);
        r.appendChild(rr);
        leftSec.appendChild(r);
    }

    function mkMixBtn(key: number, label: string): HTMLElement {
        const wrap = document.createElement("div"); wrap.className = "mmix";
        const led = document.createElement("div"); led.className = "led";
        const btn = document.createElement("div"); btn.className = "rbtn"; btn.id = `mx${key}`;
        const lbl = document.createElement("div"); lbl.className = "rlbl"; lbl.textContent = label;
        wrap.appendChild(led); wrap.appendChild(btn); wrap.appendChild(lbl);
        return wrap;
    }

    const mixRow = document.createElement("div"); mixRow.className = "mix-row";
    mixRow.appendChild(Object.assign(document.createElement("div"), { className: "tnum" }));
    mixRow.appendChild(Object.assign(document.createElement("div"), { className: "spacer-20" }));
    const mixMIX = mkMixBtn(21, "MIX"); mixMIX.classList.add("mmix-wide");
    mixRow.appendChild(mixMIX);
    mixRow.appendChild(Object.assign(document.createElement("div"), { className: "spacer-20" }));
    mixRow.appendChild(mkMixBtn(32, "SEL"));
    mixRow.appendChild(Object.assign(document.createElement("div"), { className: "spacer-20" }));
    for (let i = 0; i < 2; i++) mixRow.appendChild(Object.assign(document.createElement("div"), { className: "empty-cell" }));
    [{ k: 43, l: "ATR" }, { k: 54, l: "VOL" }, { k: 65, l: "PAN" }, { k: 76, l: "MOD" }, { k: 87, l: "EXP" }, { k: 98, l: "U0" }].forEach(m => mixRow.appendChild(mkMixBtn(m.k, m.l)));
    mixRow.appendChild(Object.assign(document.createElement("div"), { className: "empty-cell" }));
    [{ k: 109, l: "U1" }, { k: 120, l: "U2" }, { k: 131, l: "U3" }, { k: 142, l: "U4" }, { k: 153, l: "U5" }].forEach(m => mixRow.appendChild(mkMixBtn(m.k, m.l)));
    for (let i = 0; i < 2; i++) mixRow.appendChild(Object.assign(document.createElement("div"), { className: "empty-cell" }));
    mixRow.appendChild(Object.assign(document.createElement("div"), { className: "spacer-20" }));
    mixRow.appendChild(mkMixBtn(164, "MUT"));
    mixRow.appendChild(Object.assign(document.createElement("div"), { className: "spacer-20" }));
    const mixEDT = mkMixBtn(175, "EDT"); mixEDT.classList.add("mmix-wide");
    mixRow.appendChild(mixEDT);
    mixRow.appendChild(Object.assign(document.createElement("div"), { className: "spacer-20" }));
    mixRow.appendChild(mkMixBtn(186, "ESC"));
    const chordSpacer = document.createElement("div"); chordSpacer.id = "chordSpacer"; chordSpacer.style.width = "0px"; chordSpacer.style.flexShrink = "0";
    mixRow.appendChild(chordSpacer);
    [{ k: 258, l: "0" }, { k: 257, l: "1" }, { k: 256, l: "2" }, { k: 255, l: "3" }, { k: 254, l: "4" }, { k: 253, l: "5" }, { k: 252, l: "6" }].forEach(c => {
        const w = mkMixBtn(c.k, c.l);
        const rbtn = w.querySelector(".rbtn") as HTMLElement; rbtn.id = `chd-${c.k}`;
        mixRow.appendChild(w);
    });
    panel.appendChild(mixRow);

    const CX = 270, CY = 245, RO = 210, RI = 145;
    const cp = (a: number, r: number) => { const d = (a - 90) * Math.PI / 180; return { x: Math.cos(d) * r + CX, y: Math.sin(d) * r + CY }; };

    [{ t: "MODE", x: CX - 12, y: CY + 2 }, { t: "SCALE", x: CX - 14, y: CY + 102 }, { t: "TRANSPORT", x: CX - 26, y: CY + 183 }].forEach(l => {
        const e = document.createElement("div"); e.className = "plbl"; e.textContent = l.t;
        e.style.left = l.x + "px"; e.style.top = l.y + "px"; circle.appendChild(e);
    });

    function mkRBtn(key: number, label: string, a: number, r: number) {
        const p = cp(a, r);
        const led = document.createElement("div"); led.className = "led";
        const btn = document.createElement("div"); btn.className = "rbtn"; btn.id = `ck-${key}`;
        const lbl = document.createElement("div"); lbl.className = "rlbl"; lbl.textContent = label;
        const wrap = document.createElement("div"); wrap.className = "rbtn-wrap";
        wrap.style.left = (p.x - 12) + "px"; wrap.style.top = (p.y - 12) + "px";
        wrap.appendChild(led); wrap.appendChild(btn); wrap.appendChild(lbl); circle.appendChild(wrap);
    }

    const outerSlots: ({ k: number; l: string } | null)[] = new Array(32).fill(null);
    [{ k: 201, l: "1" }, { k: 200, l: "2" }, { k: 199, l: "3" }, { k: 198, l: "4" }, { k: 197, l: "5" }, { k: 207, l: "6" }, { k: 206, l: "7" }, { k: 216, l: "8" }, { k: 215, l: "9" }, { k: 224, l: "100" }, { k: 233, l: "200" }].forEach((b, i) => { outerSlots[(24 + i) % 32] = b; });
    [{ k: 213, l: "CHN" }, { k: 214, l: "FLW" }, { k: 243, l: "MY" }, { k: 244, l: "PEN" }, { k: 245, l: "WHL" }, { k: 246, l: "MAJ" }, { k: 242, l: "PGM" }, { k: 234, l: "TPO" }, { k: 247, l: "MIN" }, { k: 248, l: "DIM" }, { k: 250, l: "P4" }, { k: 241, l: "P1" }, { k: 232, l: "PSE" }, { k: 231, l: "STP" }, { k: 223, l: "REC" }, { k: 240, l: "P2" }, { k: 249, l: "CHR" }].forEach((b, i) => { outerSlots[3 + i] = b; });
    outerSlots[20] = { k: 205, l: "CH1" }; outerSlots[21] = { k: 204, l: "CH2" }; outerSlots[22] = { k: 203, l: "CH3" }; outerSlots[23] = { k: 202, l: "CH4" };

    const innerNotes = [{ k: 212, l: "C" }, { k: 211, l: "C#" }, { k: 210, l: "D" }, { k: 209, l: "D#" }, { k: 208, l: "E" }, { k: 217, l: "F" }, { k: 225, l: "F#" }, { k: 226, l: "G" }, { k: 235, l: "G#" }, { k: 236, l: "A" }, { k: 237, l: "A#" }, { k: 238, l: "B" }, { k: 239, l: "C↑" }, { k: 221, l: "MOD" }, { k: 222, l: "SEL" }, { k: 230, l: "CAD" }];
    outerSlots.forEach((b, i) => { if (b) mkRBtn(b.k, b.l, i * 11.25, RO); });
    innerNotes.forEach((b, i) => { mkRBtn(b.k, b.l, ((i - 6) * 22.5 + 360) % 360, RI); });

    [{ k: 218, l: "GRID", dx: -52, dy: -32 }, { k: 219, l: "PAGE", dx: 0, dy: -48 }, { k: 220, l: "TRK", dx: 52, dy: -32 }, { k: 227, l: "STEP", dx: -52, dy: 32 }, { k: 228, l: "MAP", dx: 0, dy: 48 }, { k: 229, l: "PLAY", dx: 52, dy: 32 }].forEach(z => {
        const wrap = document.createElement("div"); wrap.className = "rbtn-wrap";
        wrap.style.left = (CX + z.dx - 12) + "px"; wrap.style.top = (CY + z.dy - 12) + "px";
        const led = document.createElement("div"); led.className = "led";
        const e = document.createElement("div"); e.className = "rbtn"; e.id = `ck-${z.k}`;
        const lbl = document.createElement("div"); lbl.className = "rlbl"; lbl.textContent = z.l;
        wrap.appendChild(led); wrap.appendChild(e); wrap.appendChild(lbl); circle.appendChild(wrap);
    });

    const tpoWrap = document.createElement("div"); tpoWrap.className = "rbtn-wrap";
    tpoWrap.style.left = "480px"; tpoWrap.style.top = "20px";
    const tpoLed = document.createElement("div"); tpoLed.className = "led";
    const tpoRot = createKnob(0);
    const tpoLbl = document.createElement("div"); tpoLbl.className = "rlbl"; tpoLbl.textContent = "TPO";
    tpoWrap.appendChild(tpoLed); tpoWrap.appendChild(tpoRot); tpoWrap.appendChild(tpoLbl);
    circle.appendChild(tpoWrap);

    const alnWrap = document.createElement("div"); alnWrap.className = "rbtn-wrap";
    alnWrap.style.left = "490px"; alnWrap.style.top = "85px";
    const alnLed = document.createElement("div"); alnLed.className = "led";
    const alnBtn = document.createElement("div"); alnBtn.className = "rbtn"; alnBtn.id = "ck-251";
    const alnLbl = document.createElement("div"); alnLbl.className = "rlbl"; alnLbl.textContent = "ALN";
    alnWrap.appendChild(alnLed); alnWrap.appendChild(alnBtn); alnWrap.appendChild(alnLbl);
    circle.appendChild(alnWrap);

    root.querySelectorAll<HTMLElement>('[id^="p"]').forEach(el => { const m = el.id.match(/^p(\d+)_(\d+)$/); if (m) bindStepPad(el, mkey(+m[1], +m[2])); });
    root.querySelectorAll<HTMLElement>('[id^="lbt-"]').forEach(el => bindKey(el, parseInt(el.id.slice(4))));
    root.querySelectorAll<HTMLElement>('[id^="rbt-"]').forEach(el => bindKey(el, parseInt(el.id.slice(4))));
    root.querySelectorAll<HTMLElement>('[id^="ck-"]').forEach(el => bindKey(el, parseInt(el.id.slice(3))));
    root.querySelectorAll<HTMLElement>('[id^="mx"]').forEach(el => bindKey(el, parseInt(el.id.slice(2))));
    root.querySelectorAll<HTMLElement>('[id^="chd-"]').forEach(el => bindKey(el, parseInt(el.id.slice(4))));

    function fitToWidth() {
        const naturalW = panel.offsetWidth;
        const naturalH = panel.offsetHeight;
        if (!naturalW || !naturalH) return;
        const scale = Math.min(window.innerWidth / naturalW, window.innerHeight / naturalH);
        panel.style.transform = `scale(${scale})`;
        panel.style.transformOrigin = "center center";
    }
    function alignChordButtons() {
        const scaleMatch = panel.style.transform.match(/scale\(([\d.]+)\)/);
        const scale = scaleMatch ? parseFloat(scaleMatch[1]) : 1;
        const stopBtn = document.getElementById("ck-231");
        const escBtn = document.getElementById("mx186");
        const spacer = document.getElementById("chordSpacer");
        if (!stopBtn || !escBtn || !spacer) return;
        const mixRect = mixRow.getBoundingClientRect();
        const stopCenter = (stopBtn.getBoundingClientRect().left + stopBtn.getBoundingClientRect().width / 2 - mixRect.left) / scale;
        const escRight = (escBtn.getBoundingClientRect().right - mixRect.left) / scale;
        spacer.style.width = Math.max(0, stopCenter - 83 - escRight) + "px";
    }
    const resizeHandler = () => { fitToWidth(); alignChordButtons(); };
    window.addEventListener("resize", resizeHandler);
    fitToWidth();
    alignChordButtons();

    let mirAddr = 0;
    let running = true;
    let renderFrame = 0;
    const prevMir = new Uint8Array(MIR_SIZE);

    function mirChanged(curr: Uint8Array): boolean {
        for (let i = 0; i < MIR_SIZE; i++) {
            if (curr[i] !== prevMir[i]) return true;
        }
        return false;
    }

    function renderLoop() {
        if (!running) return;
        renderFrame++;

        updateTransportIndicator(module);

        module._page_refresh();
        // Use processed MIR (blink pre-applied). Must be called every frame:
        // it refills a static buffer in WASM linear memory with MIR contents
        // and clears red/green bits where the blink bit is set when the master
        // blinker is in its off phase. Using the raw MIR (get_mir_ptr) leaves
        // blink-only LEDs permanently dark and never animates blinking LEDs.
        mirAddr = module._get_processed_mir_ptr();
        if (mirAddr) {
            const mir = new Uint8Array(module.HEAPU8.buffer, mirAddr, MIR_SIZE);
            if (mirChanged(mir)) {
                updateLEDs(mir);
                prevMir.set(mir);
            }
        }
        requestAnimationFrame(renderLoop);
    }

    function mb(mir: Uint8Array, s: number, r: number, c: number) { return mir[s * 85 + r * 5 + c]; }
    function ml(mir: Uint8Array, s: number, r: number, b: number) { return ((mb(mir, s, r, 1) >> b & 1) ? 2 : 0) | ((mb(mir, s, r, 2) >> b & 1) ? 4 : 0); }

    function setL(el: HTMLElement | null, v: number) {
        if (!el) return;
        const led = el.previousElementSibling as HTMLElement || (el.parentElement?.querySelector(".led") as HTMLElement) || el;
        const ledEl = led as HTMLElement;
        if (parseInt(ledEl.dataset.mv ?? "-1") === v) return;
        ledEl.dataset.mv = String(v);
        const r = v & 2, g = v & 4;
        if (r && g) { ledEl.style.background = "#dc0"; ledEl.style.boxShadow = "0 0 5px #e80"; }
        else if (r) { ledEl.style.background = "#d00"; ledEl.style.boxShadow = "0 0 5px #f00"; }
        else if (g) { ledEl.style.background = "#0c0"; ledEl.style.boxShadow = "0 0 5px #0f0"; }
        else { ledEl.style.background = "transparent"; ledEl.style.boxShadow = "none"; }
    }

    const cm: Record<string, number[]> = {
        "225":[0,15,0],"217":[0,15,1],"208":[0,15,2],"209":[0,15,3],"210":[0,15,4],"211":[0,15,5],"212":[0,15,6],"221":[0,15,7],
        "222":[1,15,0],"230":[1,15,1],"239":[1,15,2],"238":[1,15,3],"237":[1,15,4],"236":[1,15,5],"235":[1,15,6],"226":[1,15,7],
        "218":[0,16,0],"219":[0,16,1],"227":[0,16,2],"228":[0,16,3],"220":[0,16,4],"229":[0,16,5],
        "231":[1,14,0],"232":[1,14,1],"241":[1,14,2],"240":[1,14,3],"250":[1,14,4],"249":[1,14,5],"248":[1,14,6],"247":[1,14,7],
        "201":[0,14,0],"205":[0,14,4],"204":[0,14,3],"203":[0,14,2],"202":[0,14,1],"213":[0,14,5],"214":[0,14,6],"223":[0,14,7],
        "215":[0,13,0],"216":[0,13,1],"206":[0,13,2],"207":[0,13,3],"197":[0,13,4],"198":[0,13,5],"199":[0,13,6],"200":[0,13,7],
        "246":[1,13,0],"245":[1,13,1],"244":[1,13,2],"243":[1,13,3],"242":[1,13,4],"234":[1,13,5],"233":[1,13,6],"224":[1,13,7],
        "251":[1,16,7],"252":[1,16,6],"253":[1,16,5],"254":[1,16,4],"255":[1,16,3],"256":[1,16,2],"257":[1,16,1],"258":[1,16,0],
    };

    function updateLEDs(mir: Uint8Array) {
        for (let row = 0; row < 10; row++) for (let col = 0; col < 8; col++) {
            setL(document.getElementById(`p${row}_${col}`), ml(mir, 0, row, col));
            setL(document.getElementById(`p${row}_${col + 8}`), ml(mir, 1, row, col));
        }
        const mk = [21, 32, 43, 54, 65, 76, 87, 98, 109, 120, 131, 142, 153, 164, 175, 186];
        const mm = [[0,10,0],[0,10,1],[0,10,2],[0,10,3],[0,10,4],[0,10,5],[0,10,6],[0,10,7],[1,10,0],[1,10,1],[1,10,2],[1,10,3],[1,10,4],[1,10,5],[1,10,6],[1,10,7]];
        mk.forEach((k, i) => setL(document.getElementById(`mx${k}`), ml(mir, mm[i][0], mm[i][1], mm[i][2])));
        for (const [k, p] of Object.entries(cm)) {
            setL(document.getElementById(`ck-${k}`), ml(mir, p[0], p[1], p[2]));
            setL(document.getElementById(`chd-${k}`), ml(mir, p[0], p[1], p[2]));
        }
        for (let i = 0; i < 5; i++) {
            setL(document.getElementById(`lbt-${i + 1}`), ml(mir, 0, 11, 4 - i));
            setL(document.getElementById(`lbt-${i + 6}`), ml(mir, 0, 12, 5 - i));
            setL(document.getElementById(`rbt-${187 + i}`), ml(mir, 1, 11, i + 1));
            setL(document.getElementById(`rbt-${192 + i}`), ml(mir, 1, 12, i));
        }
    }

    requestAnimationFrame(renderLoop);

    return () => {
        running = false;
        document.removeEventListener("mousemove", mouseMoveHandler);
        document.removeEventListener("mouseup", mouseUpHandler);
        document.removeEventListener("mouseup", mouseUpClear);
        window.removeEventListener("resize", resizeHandler);
    };
}

function updateTransportIndicator(module: OctopusWasmModule) {
    const indicator = document.getElementById("oct-transport-indicator");
    if (!indicator) return;
    const playing = module._get_run_bit() !== 0;
    const text = playing ? "PLAYING" : "STOPPED";
    if (indicator.textContent !== text) {
        indicator.textContent = text;
        indicator.className = playing ? "transport-playing" : "transport-stopped";
    }
}
