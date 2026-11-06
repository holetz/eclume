buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:9.3.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
    // The :tauri-android source lives in the cargo registry, and each plugin's build.rs copies it whole
    // while Gradle compiles. The output goes outside it, so the copy never reads a tree being written.
    if (name == "tauri-android") {
        layout.buildDirectory.set(rootProject.layout.buildDirectory.dir("tauri-android"))
    }
}

tasks.register("clean").configure {
    delete("build")
}

