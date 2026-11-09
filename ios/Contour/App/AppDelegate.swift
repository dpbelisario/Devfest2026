import UIKit
import UserNotifications

@main
final class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var window: UIWindow?
    let controller = ContourViewController()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) { controller.resumeDeviceActivity() }
    func applicationWillResignActive(_ application: UIApplication) { controller.stopDeviceActivity() }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        if let alert = ContourAlert(payload: notification.request.content.userInfo) { controller.presentAlert(alert) }
        completionHandler([.sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let alert = ContourAlert(payload: response.notification.request.content.userInfo) { controller.presentAlert(alert) }
        completionHandler()
    }
}

/// A single-window scene keeps camera/location lifecycle handling compatible with iOS 27 SDK builds.
final class ContourSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene,
              let app = UIApplication.shared.delegate as? AppDelegate else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = app.controller
        self.window = window
        app.window = window
        window.makeKeyAndVisible()
    }
    func sceneDidBecomeActive(_ scene: UIScene) {
        (UIApplication.shared.delegate as? AppDelegate)?.controller.resumeDeviceActivity()
    }
    func sceneWillResignActive(_ scene: UIScene) {
        (UIApplication.shared.delegate as? AppDelegate)?.controller.stopDeviceActivity()
    }
    func sceneDidDisconnect(_ scene: UIScene) {
        (UIApplication.shared.delegate as? AppDelegate)?.controller.stopDeviceActivity()
    }
}
