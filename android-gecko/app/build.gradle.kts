plugins {
    id("com.android.application")
}

val preproductionKeystorePath =
    providers.environmentVariable("BKE_ANDROID_PREPRODUCTION_KEYSTORE_PATH").orNull
val preproductionStorePassword =
    providers.environmentVariable("BKE_ANDROID_PREPRODUCTION_STORE_PASSWORD").orNull
val preproductionKeyAlias =
    providers.environmentVariable("BKE_ANDROID_PREPRODUCTION_KEY_ALIAS").orNull
val preproductionKeyPassword =
    providers.environmentVariable("BKE_ANDROID_PREPRODUCTION_KEY_PASSWORD").orNull

android {
    namespace = "com.bke.worker.gecko"
    compileSdk {
        version = release(37) {
            minorApiLevel = 1
        }
    }

    defaultConfig {
        applicationId = "com.bke.worker.gecko"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.0.1-probe"
        manifestPlaceholders["appLabel"] = "BKE Worker"

        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    signingConfigs {
        create("preproduction") {
            if (!preproductionKeystorePath.isNullOrBlank()) {
                storeFile = file(preproductionKeystorePath)
            }
            storePassword = preproductionStorePassword
            keyAlias = preproductionKeyAlias
            keyPassword = preproductionKeyPassword
        }
    }

    buildTypes {
        getByName("debug") {
            isDebuggable = true
        }

        create("recovery") {
            initWith(getByName("debug"))
            applicationIdSuffix = ".recoverycert"
            versionNameSuffix = "-recoverycert"
            manifestPlaceholders["appLabel"] = "BKE Worker Recovery Cert"
            isDebuggable = true
        }

        create("preproduction") {
            initWith(getByName("debug"))
            isDebuggable = false
            signingConfig = signingConfigs.getByName("preproduction")
            matchingFallbacks += listOf("release", "debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("org.mozilla.geckoview:geckoview-arm64-v8a:154.0.20260824154132")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
