import UIKit
import Capacitor

// The web app's view controller, plus WonkoLingo's own native plugin.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(WonkoNativePlugin())
    }
}
