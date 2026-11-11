// farfield-ax: reads the text and structure of the front window with macOS's own Accessibility API.
// It only reads. It does not click, type, or take screenshots. It needs the Accessibility permission for the app that runs it
// (for example Terminal), and the app being read may need its accessibility tree switched on (see --enable).
//
// STATUS: written without being compiled or run. The first run may show compile errors; paste them back.
//
// Usage: farfield-ax [--max 2000] [--depth 40] [--seconds 25] [--enable]
// Prints one JSON object on standard output.
import Cocoa
import ApplicationServices

struct Node: Encodable {
    var role: String
    var sub: String
    var depth: Int
    var text: String
    var dom: String
}

struct Output: Encodable {
    var engine: String
    var visited: Int
    var errors: [String]
    var windows: Int
    var chosen: Int
    var app: String
    var title: String
    var accessibility: [String: String]
    var nodes: [Node]
}

let args = CommandLine.arguments
func opt(_ name: String, _ fallback: Int) -> Int {
    if let i = args.firstIndex(of: name), i + 1 < args.count, let v = Int(args[i + 1]) { return v }
    return fallback
}
let maxNodes = opt("--max", 2000)
let maxDepth = opt("--depth", 40)
let seconds = opt("--seconds", 25)
let enable = args.contains("--enable")

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var ref: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, name as CFString, &ref)
    return err == .success ? ref : nil
}

func str(_ v: CFTypeRef?) -> String {
    guard let v = v else { return "" }
    if CFGetTypeID(v) == CFStringGetTypeID() { return (v as! CFString) as String }
    return ""
}

func flag(_ v: CFTypeRef?) -> Bool {
    guard let v = v else { return false }
    if CFGetTypeID(v) == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) }
    return false
}

if !AXIsProcessTrusted() {
    fail("macOS has not allowed this. Open System Settings > Privacy & Security > Accessibility, turn on the app you ran this from (for example Terminal), then run it again. (Accessibility permission missing)")
}

guard let front = NSWorkspace.shared.frontmostApplication else { fail("Could not find the front app.") }
let app = AXUIElementCreateApplication(front.processIdentifier)
let appName = front.localizedName ?? ""

// Asking the app to build its accessibility tree, as VoiceOver would. It stays on in that app until the app is quit.
var accessibility: [String: String] = [:]
if enable {
    for name in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
        let err = AXUIElementSetAttributeValue(app, name as CFString, kCFBooleanTrue)
        accessibility[name] = err == .success ? "set" : "failed: AXError \(err.rawValue)"
    }
    Thread.sleep(forTimeInterval: 3)
}

// Browsers keep several windows (helpers with no title or content). Choose the real, main one.
var windows: [AXUIElement] = []
if let list = attr(app, "AXWindows") as? [AXUIElement] { windows = list }
if windows.isEmpty, let focused = attr(app, "AXFocusedWindow") { windows = [focused as! AXUIElement] }

var best: AXUIElement? = nil
var bestScore = -1.0
var bestIndex = -1
for (i, w) in windows.enumerated() {
    var score = 0.0
    if str(attr(w, "AXSubrole")) == "AXStandardWindow" { score += 2 }
    if flag(attr(w, "AXMain")) { score += 4 }
    if flag(attr(w, "AXFocused")) { score += 4 }
    if !str(attr(w, "AXTitle")).isEmpty { score += 1 }
    if let kids = attr(w, "AXChildren") as? [AXUIElement], !kids.isEmpty { score += 1 }
    score -= Double(i) * 0.01
    if score > bestScore { best = w; bestScore = score; bestIndex = i }
}

guard let win = best else { fail("The front app has no window to read.") }
let title = str(attr(win, "AXTitle"))

let keep: Set<String> = ["AXWebArea", "AXHeading", "AXStaticText", "AXTextArea", "AXTextField", "AXList", "AXTable", "AXOutline", "AXScrollArea", "AXSplitGroup"]
var nodes: [Node] = []
var errors: [String] = []
var visited = 0
let deadline = Date().addingTimeInterval(Double(seconds))
var stack: [(AXUIElement, Int)] = [(win, 0)]

while let (el, d) = stack.popLast() {
    if visited >= maxNodes || Date() > deadline { break }
    visited += 1

    let role = str(attr(el, "AXRole"))
    let sub = str(attr(el, "AXSubrole"))
    var text = str(attr(el, "AXValue"))
    if text.isEmpty { text = str(attr(el, "AXTitle")) }
    if text.isEmpty { text = str(attr(el, "AXDescription")) }
    if text.count > 4000 { text = String(text.prefix(4000)) }

    // Web pages carry the page's own element id and class names, which may show which messages are yours and which are the AI's.
    var dom = str(attr(el, "AXDOMIdentifier"))
    if let classes = attr(el, "AXDOMClassList") as? [String], !classes.isEmpty {
        dom += "." + classes.joined(separator: ".")
    }
    if dom.count > 120 { dom = String(dom.prefix(120)) }

    if !text.isEmpty || d <= 4 || keep.contains(role) || !dom.isEmpty {
        nodes.append(Node(role: role, sub: sub, depth: d, text: text, dom: dom))
    }

    if d < maxDepth {
        var kidsRef: CFTypeRef?
        let e = AXUIElementCopyAttributeValue(el, "AXChildren" as CFString, &kidsRef)
        if e == .success {
            if let kids = kidsRef as? [AXUIElement] {
                for k in kids.reversed() { stack.append((k, d + 1)) }
            }
        } else if e != .noValue && e != .attributeUnsupported && errors.count < 5 {
            errors.append("children: AXError \(e.rawValue) at \(role)")
        }
    }
}

let out = Output(engine: "native", visited: visited, errors: errors, windows: windows.count, chosen: bestIndex,
                 app: appName, title: title, accessibility: accessibility, nodes: nodes)
let encoder = JSONEncoder()
guard let data = try? encoder.encode(out), let json = String(data: data, encoding: .utf8) else { fail("Could not write the result.") }
print(json)
