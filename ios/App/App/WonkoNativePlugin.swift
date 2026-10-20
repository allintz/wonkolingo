import Foundation
import UIKit
import WidgetKit
import AuthenticationServices
import Capacitor

// Called from the web app as `WonkoNative`: hands the streak to the widget, opens iPhone Settings, and does passkeys.
@objc(WonkoNativePlugin)
public class WonkoNativePlugin: CAPPlugin, CAPBridgedPlugin, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "WonkoNativePlugin"
    public let jsName = "WonkoNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setWidgetData", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "passkeyCreate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "passkeyGet", returnType: CAPPluginReturnPromise)
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

    // MARK: Passkeys
    // The app's pages come from capacitor://localhost, which can't use the site's passkeys in the web view, so they're made
    // here with the site as the relying party (allowed by the webcredentials associated domain). Options arrive as the
    // server's WebAuthn JSON; results go back in the same JSON shape a browser produces.

    private var passkeyCall: CAPPluginCall?
    private var passkeyController: ASAuthorizationController?

    @objc func passkeyCreate(_ call: CAPPluginCall) {
        guard let o = call.getObject("options"), let rp = (o["rp"] as? JSObject)?["id"] as? String,
              let challenge = Self.data(o["challenge"] as? String), let user = o["user"] as? JSObject,
              let userID = Self.data(user["id"] as? String), let name = user["name"] as? String else {
            call.reject("The passkey request was malformed.")
            return
        }
        let request = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rp)
            .createCredentialRegistrationRequest(challenge: challenge, name: name, userID: userID)
        request.userVerificationPreference = .preferred
        if #available(iOS 17.4, *), let exclude = o["excludeCredentials"] as? JSArray {
            request.excludedCredentials = exclude.compactMap { Self.data(($0 as? JSObject)?["id"] as? String) }
                .map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
        }
        perform(request, call)
    }

    @objc func passkeyGet(_ call: CAPPluginCall) {
        guard let o = call.getObject("options"), let rp = o["rpId"] as? String, let challenge = Self.data(o["challenge"] as? String) else {
            call.reject("The passkey request was malformed.")
            return
        }
        let request = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rp).createCredentialAssertionRequest(challenge: challenge)
        request.userVerificationPreference = .preferred
        if let allow = o["allowCredentials"] as? JSArray, !allow.isEmpty {
            request.allowedCredentials = allow.compactMap { Self.data(($0 as? JSObject)?["id"] as? String) }
                .map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
        }
        perform(request, call)
    }

    private func perform(_ request: ASAuthorizationRequest, _ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.passkeyCall?.reject("Another passkey request started.", "canceled")
            self.passkeyCall = call
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.passkeyController = controller
            controller.performRequests()
        }
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let call = passkeyCall else { return }
        passkeyCall = nil
        passkeyController = nil
        if let r = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration {
            guard let attestation = r.rawAttestationObject else { call.reject("The passkey couldn't be created."); return }
            call.resolve(["credential": Self.credential(r.credentialID, [
                "clientDataJSON": Self.b64url(r.rawClientDataJSON),
                "attestationObject": Self.b64url(attestation),
                "transports": ["internal", "hybrid"]
            ])])
        } else if let a = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
            call.resolve(["credential": Self.credential(a.credentialID, [
                "clientDataJSON": Self.b64url(a.rawClientDataJSON),
                "authenticatorData": Self.b64url(a.rawAuthenticatorData),
                "signature": Self.b64url(a.signature),
                "userHandle": Self.b64url(a.userID)
            ])])
        } else {
            call.reject("That sign-in method isn't supported.")
        }
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard let call = passkeyCall else { return }
        passkeyCall = nil
        passkeyController = nil
        if (error as? ASAuthorizationError)?.code == .canceled {
            call.reject("The passkey request was cancelled.", "canceled")
        } else {
            call.reject(error.localizedDescription, "failed")
        }
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    private static func credential(_ id: Data, _ response: [String: Any]) -> [String: Any] {
        let b = b64url(id)
        return ["id": b, "rawId": b, "type": "public-key", "authenticatorAttachment": "platform", "clientExtensionResults": [String: Any](), "response": response]
    }
    private static func data(_ s: String?) -> Data? {
        guard var t = s?.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") else { return nil }
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }
    private static func b64url(_ d: Data?) -> String {
        return (d ?? Data()).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
