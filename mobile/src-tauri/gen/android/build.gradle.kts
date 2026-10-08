buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:9.3.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.10")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
    // O fonte do :tauri-android mora no registro do cargo, e o build.rs de cada plugin o copia inteiro
    // enquanto o Gradle compila. A saída vai para fora dele, para a cópia não ler uma árvore em escrita.
    if (name == "tauri-android") {
        layout.buildDirectory.set(rootProject.layout.buildDirectory.dir("tauri-android"))
    }
}

tasks.register("clean").configure {
    delete("build")
}

