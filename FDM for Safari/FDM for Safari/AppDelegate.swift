//
//  AppDelegate.swift
//  FDM for Safari
//
//  Created by Hamed Macsword on 2026/10/20.
//

import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    func applicationDidFinishLaunching(_ notification: Notification) {
        BridgeServer.shared.start()
        if CommandLine.arguments.contains("--bridge") {
            NSApp.setActivationPolicy(.accessory)
            for window in NSApp.windows {
                window.orderOut(nil)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

}
