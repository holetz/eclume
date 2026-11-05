---
title: Why the device asks about the certificate
topic: conectar
pages: [app-desktop, app-movel, mcp]
related: [link-a-device, connect-mcp-assistant, install-desktop-app]
terms: [certificate, HTTPS, security, fingerprint, CA, trust, browser warning, certificate change, next root]
order: 5
updated: 2026-10-01
---
This server uses a certificate of its own, not one from a public authority. The connection is
encrypted just the same, but each device needs to know it is talking to the right server.

## How the apps check

The apps do not ask you to install anything. They check the certificate's **fingerprint**, a sequence
that identifies the server, received through a trusted path:

- **through the installer**, when you downloaded the app from this server;
- **over the network**, when the app finds the server on its own;
- **through the QR**, on the phone.

With an address typed by hand, the app shows the fingerprint for you to check with whoever
administers the server before going on.

## Browser and Claude Desktop

The browser and Claude Desktop trust the certificate when the computer trusts its root.
Download the root at [/downloads/eclume-root.crt](/downloads/eclume-root.crt) and install it as a
trusted authority in the system. Whoever administers the server has the step-by-step for each system.

## Phone browser

The app's **Open on the web** opens the recording in the Android browser, which also needs to trust
the root. Download [the server root](/downloads/eclume-root.crt) on the phone and install it in
Settings › Security › Encryption & credentials › Install a certificate › **CA certificate** (the
path varies a little between makers). Without it, the browser shows the not-private-connection warning.

## When the server's certificate changes

This server's root is only valid for its own address: installed on a computer, it cannot be used to
impersonate any other site.

When whoever administers the server replaces the root, it is announced beforehand. Updated apps
store the new one on their own and keep working through the change, with no need to sign in again. An
app that fell behind shows **"The server certificate changed"**: sign in or pair again.

In the browser and Claude Desktop, also install [the next root](/downloads/eclume-root-proxima.crt)
when whoever administers the server says so, beside the current one. After the change, the old one can go.
