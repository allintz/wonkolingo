import Foundation
import UIKit
import WidgetKit
import AuthenticationServices
import Capacitor
import CryptoKit

// Called from the web app as `WonkoNative`: hands the streak to the widget, opens iPhone Settings, and does passkeys,
// Sign in with Apple and Sign in with Google.
@objc(WonkoNativePlugin)
public class WonkoNativePlugin: CAPPlugin, CAPBridgedPlugin, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "WonkoNativePlugin"
    public let jsName = "WonkoNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setWidgetData", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "passkeyCreate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "passkeyGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appleSignIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "googleSignIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "apsEnvironment", returnType: CAPPluginReturnPromise)
    ]

    // Which Apple push service this build talks to: builds installed from Xcode carry a provisioning profile that says
    // "development" (sandbox); TestFlight and App Store builds have none and use production.
    @objc func apsEnvironment(_ call: CAPPluginCall) {
        var sandbox = false
        if let path = Bundle.main.path(forResource: "embedded", ofType: "mobileprovision"),
           let data = FileManager.default.contents(atPath: path) {
            let text = String(decoding: data, as: UTF8.self)
            sandbox = text.range(of: "<key>aps-environment</key>\\s*<string>development</string>", options: .regularExpression) != nil
        }
        call.resolve(["sandbox": sandbox])
    }

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

    // MARK: Sign in with Apple
    // Returns Apple's identity token (checked by the server at /api/apple) and, on the first sign-in only, the first name.
    @objc func appleSignIn(_ call: CAPPluginCall) {
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        perform(request, call)
    }

    // MARK: Sign in with Google
    // Google doesn't allow its sign-in inside an app's web view, so it runs in Apple's sign-in browser sheet
    // (ASWebAuthenticationSession) as an OAuth code flow with PKCE, using the iOS client id the page passes in. The code
    // is exchanged here for Google's ID token, which the page sends to /api/google.
    private var googleSession: ASWebAuthenticationSession?

    @objc func googleSignIn(_ call: CAPPluginCall) {
        guard let clientId = call.getString("clientId"), clientId.hasSuffix(".apps.googleusercontent.com") else {
            call.reject("Google sign-in isn't set up.")
            return
        }
        let scheme = "com.googleusercontent.apps." + clientId.replacingOccurrences(of: ".apps.googleusercontent.com", with: "")
        let redirect = scheme + ":/oauth2redirect"
        let verifier = Self.b64url(Data((0..<32).map { _ in UInt8.random(in: 0...255) }))
        let challenge = Self.b64url(Data(SHA256.hash(data: Data(verifier.utf8))))
        let state = UUID().uuidString
        var c = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        c.queryItems = [
            URLQueryItem(name: "client_id", value: clientId), URLQueryItem(name: "redirect_uri", value: redirect),
            URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "scope", value: "openid email profile"),
            URLQueryItem(name: "code_challenge", value: challenge), URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state), URLQueryItem(name: "prompt", value: "select_account")
        ]
        DispatchQueue.main.async {
            let session = ASWebAuthenticationSession(url: c.url!, callbackURLScheme: scheme) { url, error in
                self.googleSession = nil
                if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
                    call.reject("Google sign-in was cancelled.", "canceled"); return
                }
                guard let url = url, let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
                      items.first(where: { $0.name == "state" })?.value == state,
                      let code = items.first(where: { $0.name == "code" })?.value else {
                    call.reject(error?.localizedDescription ?? "Google sign-in didn't finish.", "failed"); return
                }
                Self.exchange(code: code, clientId: clientId, redirect: redirect, verifier: verifier) { token in
                    if let token = token { call.resolve(["credential": token]) } else { call.reject("Google sign-in didn't finish.", "failed") }
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.googleSession = session
            if !session.start() { self.googleSession = nil; call.reject("Google sign-in couldn't start.", "failed") }
        }
    }

    // Swaps the one-time code for tokens. iOS clients have no secret; PKCE ties the code to this request.
    private static func exchange(code: String, clientId: String, redirect: String, verifier: String, done: @escaping (String?) -> Void) {
        var req = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let form = ["code": code, "client_id": clientId, "redirect_uri": redirect, "code_verifier": verifier, "grant_type": "authorization_code"]
        var allowed = CharacterSet.alphanumerics; allowed.insert(charactersIn: "-._~")
        req.httpBody = form.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }.joined(separator: "&").data(using: .utf8)
        URLSession.shared.dataTask(with: req) { data, _, _ in
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async { done(json?["id_token"] as? String) }
        }.resume()
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    private func perform(_ request: ASAuthorizationRequest, _ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.passkeyCall?.reject("Another sign-in request started.", "canceled")
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
        } else if let a = authorization.credential as? ASAuthorizationAppleIDCredential {
            guard let t = a.identityToken, let token = String(data: t, encoding: .utf8) else { call.reject("Apple sign-in didn't finish.", "failed"); return }
            call.resolve(["credential": token, "name": a.fullName?.givenName ?? ""])
        } else {
            call.reject("That sign-in method isn't supported.")
        }
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard let call = passkeyCall else { return }
        passkeyCall = nil
        passkeyController = nil
        switch (error as? ASAuthorizationError)?.code {
        case .canceled?: call.reject("The sign-in request was cancelled.", "canceled")
        // Apple reports "unknown" when the device has no Apple Account signed in (or Sign in with Apple isn't available).
        case .unknown?: call.reject("Make sure you're signed in to your Apple Account in Settings, then try again.", "unavailable")
        default: call.reject("Please try again.", "failed")
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
