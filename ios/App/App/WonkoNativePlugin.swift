import Foundation
import UIKit
import WidgetKit
import Capacitor

// Called from the web app as `WonkoNative`: hands the streak to the widget and opens iPhone Settings.
@objc(WonkoNativePlugin)
public class WonkoNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WonkoNativePlugin"
    public let jsName = "WonkoNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setWidgetData", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise)
    ]

    // The web app sends one JSON entry per day for the next two weeks (see pushWidget in wonkolingo.html).
    @objc func setWidgetData(_ call: CAPPluginCall) {
        guard let json = call.getString("json"), let store = UserDefaults(suiteName: WidgetStore.appGroup) else {
            call.reject("Widget storage isn't available.")
            return
        }
        store.set(json, forKey: WidgetStore.key)
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            call.resolve()
        }
    }
}
