import { readFile } from "node:fs/promises";
import { scanSwiftFiles } from "../utils/file-scanner.js";
import { parseImportsFromFiles } from "../parsers/swift-import-parser.js";
import { formatTable } from "../utils/formatter.js";
import type { UnusedImportEntry } from "../types/analysis.js";

/**
 * Known symbols for popular iOS frameworks.
 * Used to determine if an import is actually used in a file.
 */
const MODULE_SYMBOLS: Record<string, string[]> = {
  UIKit: ["UI", "NS", "CGRect", "CGPoint", "CGSize", "CGFloat", "CGAffineTransform", "UIColor", "UIFont", "UIImage", "UIView", "UIViewController", "UITableView", "UICollectionView", "UIButton", "UILabel", "UITextField", "UITextView", "UINavigationController", "UITabBarController", "UIAlertController", "UIStoryboard", "UIScreen", "UIApplication", "UIWindow", "UIDevice", "UIGestureRecognizer", "UIPasteboard", "UISearchBar", "UIScrollView", "UIStackView", "UISwitch", "UISlider", "UIStepper", "UISegmentedControl", "UIPageControl", "UIActivityIndicatorView", "UIProgressView", "UIPickerView", "UIDatePicker", "UIImagePickerController", "UIMenuController", "UIResponder", "UIControl", "UIBarButtonItem", "UIToolbar", "UITabBar", "UINavigationBar", "UIRefreshControl", "UITableViewCell", "UICollectionViewCell", "indexPath", "tableView", "collectionView"],
  SwiftUI: ["some View", "View", "Text", "Image", "Button", "NavigationStack", "NavigationView", "NavigationLink", "List", "ForEach", "VStack", "HStack", "ZStack", "Group", "Form", "Section", "Toggle", "Picker", "Slider", "Stepper", "DatePicker", "ColorPicker", "@State", "@Binding", "@ObservedObject", "@StateObject", "@EnvironmentObject", "@Environment", "@Published", "@Observable", "ObservableObject", "Binding", "body"],
  Foundation: ["Date", "URL", "Data", "UUID", "Locale", "TimeZone", "Calendar", "DateFormatter", "NumberFormatter", "JSONEncoder", "JSONDecoder", "PropertyListEncoder", "PropertyListDecoder", "UserDefaults", "FileManager", "Bundle", "ProcessInfo", "Notification", "NotificationCenter", "Timer", "URLSession", "URLRequest", "URLResponse", "HTTPURLResponse", "NSObject", "NSError", "NSCoding", "NSCopying", "Codable", "Encodable", "Decodable", "NSAttributedString", "NSRegularExpression", "DispatchQueue", "OperationQueue"],
  Combine: ["Publisher", "Subscriber", "Cancellable", "AnyCancellable", "AnyPublisher", "PassthroughSubject", "CurrentValueSubject", "Just", "Future", "sink", "assign", "store", "eraseToAnyPublisher", "receive", "map", "flatMap", "filter", "combineLatest", "merge", "zip"],
  RxSwift: ["Observable", "Observer", "Disposable", "DisposeBag", "BehaviorRelay", "PublishRelay", "BehaviorSubject", "PublishSubject", "ReplaySubject", "Single", "Completable", "Maybe", "subscribe", "disposed", "bind", "drive", "map", "flatMap", "filter", "withLatestFrom", "combineLatest", "merge", "zip", "onNext", "onError", "onCompleted"],
  RxCocoa: ["rx", "ControlProperty", "ControlEvent", "Driver", "Signal", "SharedSequence"],
  SnapKit: ["snp", "ConstraintMaker", "makeConstraints", "remakeConstraints", "updateConstraints", "Constraint"],
  Kingfisher: ["kf", "KFImage", "ImageCache", "KingfisherManager", "ImageDownloader", "KFCrossPlatformImage"],
  Moya: ["MoyaProvider", "TargetType", "MoyaError", "Response", "Endpoint", "Task", "Method"],
  Alamofire: ["AF", "Session", "DataRequest", "DownloadRequest", "UploadRequest", "HTTPMethod", "HTTPHeaders", "ParameterEncoding", "JSONEncoding", "URLEncoding"],
  Then: ["then", "do", "with"],
  Swinject: ["Container", "Assembler", "Assembly", "Resolver", "ServiceEntry"],
  CoreData: ["NSManagedObject", "NSManagedObjectContext", "NSPersistentContainer", "NSFetchRequest", "NSEntityDescription", "NSPredicate", "NSSortDescriptor", "NSFetchedResultsController", "@FetchRequest"],
  CoreLocation: ["CLLocation", "CLLocationManager", "CLLocationCoordinate2D", "CLGeocoder", "CLPlacemark", "CLRegion", "CLCircularRegion", "CLAuthorizationStatus"],
  MapKit: ["MKMapView", "MKAnnotation", "MKPointAnnotation", "MKCoordinateRegion", "MKDirections", "MKRoute", "MKMapItem", "Map"],
  AVFoundation: ["AVPlayer", "AVPlayerItem", "AVPlayerLayer", "AVCaptureSession", "AVCaptureDevice", "AVAudioSession", "AVAsset", "AVURLAsset"],
  WebKit: ["WKWebView", "WKNavigationDelegate", "WKUIDelegate", "WKWebViewConfiguration", "WKUserContentController"],
  KeychainSwift: ["KeychainSwift"],
  CryptoSwift: ["AES", "SHA256", "MD5", "HMAC", "Cipher", "Digest"],
};

export interface UnusedImportsOptions {
  projectPath: string;
  targetPaths?: string[];
  confidence?: "high" | "medium" | "low";
  excludePatterns?: string[];
}

export async function detectUnusedImports(
  options: UnusedImportsOptions,
): Promise<string> {
  const {
    projectPath,
    targetPaths,
    confidence = "medium",
    excludePatterns = [],
  } = options;

  let swiftFiles: string[];
  if (targetPaths && targetPaths.length > 0) {
    // Scan only specified paths
    const { scanFiles } = await import("../utils/file-scanner.js");
    swiftFiles = await scanFiles({
      patterns: targetPaths.map((p) => (p.endsWith(".swift") ? p : `${p}/**/*.swift`)),
      cwd: projectPath,
      ignore: excludePatterns,
    });
  } else {
    swiftFiles = await scanSwiftFiles(projectPath, excludePatterns);
  }

  const importMap = await parseImportsFromFiles(swiftFiles);
  const unused: UnusedImportEntry[] = [];

  for (const [filePath, imports] of importMap) {
    const source = await readFile(filePath, "utf-8");
    // Remove import lines themselves to avoid false negatives
    const sourceWithoutImports = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("import ") && !line.trim().startsWith("@testable import "))
      .join("\n");

    for (const imp of imports) {
      const result = checkImportUsage(imp.module, sourceWithoutImports);

      if (!result.isUsed) {
        if (confidence === "high" && result.confidence !== "high") continue;
        if (confidence === "medium" && result.confidence === "low") continue;

        unused.push({
          filePath: filePath.replace(projectPath + "/", ""),
          module: imp.module,
          line: imp.line,
          confidence: result.confidence,
          reason: result.reason,
        });
      }
    }
  }

  // Format output
  const lines: string[] = [];
  lines.push("## Unused Import Detection\n");
  lines.push(`- **Files scanned:** ${swiftFiles.length}`);
  lines.push(`- **Potentially unused imports:** ${unused.length}`);
  lines.push(`- **Confidence filter:** ${confidence}\n`);

  if (unused.length === 0) {
    lines.push("No unused imports detected at the specified confidence level.");
    return lines.join("\n");
  }

  // Group by confidence
  const highConf = unused.filter((u) => u.confidence === "high");
  const medConf = unused.filter((u) => u.confidence === "medium");
  const lowConf = unused.filter((u) => u.confidence === "low");

  if (highConf.length > 0) {
    lines.push(`### High Confidence (${highConf.length})`);
    lines.push("These imports are very likely unused:\n");
    const rows = highConf.map((u) => [u.filePath, u.module, String(u.line), u.reason]);
    lines.push(formatTable(["File", "Import", "Line", "Reason"], rows));
  }

  if (medConf.length > 0 && confidence !== "high") {
    lines.push(`\n### Medium Confidence (${medConf.length})`);
    lines.push("These imports might be unused (verify manually):\n");
    const rows = medConf.map((u) => [u.filePath, u.module, String(u.line), u.reason]);
    lines.push(formatTable(["File", "Import", "Line", "Reason"], rows));
  }

  if (lowConf.length > 0 && confidence === "low") {
    lines.push(`\n### Low Confidence (${lowConf.length})`);
    const rows = lowConf.map((u) => [u.filePath, u.module, String(u.line), u.reason]);
    lines.push(formatTable(["File", "Import", "Line", "Reason"], rows));
  }

  return lines.join("\n");
}

function checkImportUsage(
  module: string,
  source: string,
): { isUsed: boolean; confidence: "high" | "medium" | "low"; reason: string } {
  // Check known symbols first
  const knownSymbols = MODULE_SYMBOLS[module];
  if (knownSymbols) {
    const usedSymbol = knownSymbols.find((sym) => source.includes(sym));
    if (usedSymbol) {
      return { isUsed: true, confidence: "high", reason: `Uses ${usedSymbol}` };
    }
    return {
      isUsed: false,
      confidence: "high",
      reason: `No known ${module} symbols found in file`,
    };
  }

  // For unknown modules, check if the module name appears anywhere
  if (source.includes(module)) {
    return { isUsed: true, confidence: "medium", reason: `Module name "${module}" found in source` };
  }

  // Check for common prefixes derived from module name
  // e.g., "FirebaseAnalytics" -> check for "Analytics", "Firebase"
  const parts = module.match(/[A-Z][a-z]+/g) ?? [];
  for (const part of parts) {
    if (part.length > 3 && source.includes(part)) {
      return { isUsed: true, confidence: "low", reason: `Partial match: "${part}"` };
    }
  }

  return {
    isUsed: false,
    confidence: "medium",
    reason: `No reference to "${module}" found`,
  };
}
