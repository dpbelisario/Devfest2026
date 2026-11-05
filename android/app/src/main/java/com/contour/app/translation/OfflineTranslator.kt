package com.contour.app.translation

import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.common.model.RemoteModelManager
import com.google.mlkit.nl.translate.TranslateLanguage
import com.google.mlkit.nl.translate.TranslateRemoteModel
import com.google.mlkit.nl.translate.Translation
import com.google.mlkit.nl.translate.Translator
import com.google.mlkit.nl.translate.TranslatorOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext

/** Languages supported offline in this app. `zh` is Simplified Chinese. */
val SUPPORTED_LANGUAGES = listOf(
    TranslateLanguage.ENGLISH,
    TranslateLanguage.JAPANESE,
    TranslateLanguage.CHINESE,
    TranslateLanguage.KOREAN,
)

/**
 * Offline text translation backed by ML Kit. Each language is a separate model
 * download; any pair among supported languages works once both models exist.
 */
class OfflineTranslator {

    private val translators = mutableMapOf<Pair<String, String>, Translator>()
    private val modelManager = RemoteModelManager.getInstance()

    /** Auto-detects source language based on character script. */
    fun detectLanguage(text: String): String {
        val hasJapanese = text.any { it in '\u3040'..'\u30ff' }
        if (hasJapanese) return TranslateLanguage.JAPANESE
        val hasKorean = text.any { it in '\uac00'..'\ud7af' || it in '\u3130'..'\u318f' }
        if (hasKorean) return TranslateLanguage.KOREAN
        val hasChinese = text.any { it in '\u4e00'..'\u9faf' }
        if (hasChinese) return TranslateLanguage.CHINESE
        return TranslateLanguage.ENGLISH
    }

    suspend fun isLanguageReady(language: String): Boolean = withContext(Dispatchers.IO) {
        val model = TranslateRemoteModel.Builder(language).build()
        modelManager.isModelDownloaded(model).await()
    }

    /** Downloads one language model. Call while online, during setup. */
    suspend fun downloadLanguage(language: String) = withContext(Dispatchers.IO) {
        val model = TranslateRemoteModel.Builder(language).build()
        modelManager.download(model, DownloadConditions.Builder().build()).await()
    }

    /**
     * Translates [text]. Auto-detects source language if [source] is "auto" or blank.
     * If source language matches target language, returns [text] directly.
     */
    suspend fun translate(text: String, source: String, target: String): String =
        withContext(Dispatchers.IO) {
            val trimmed = text.trim()
            if (trimmed.isEmpty()) return@withContext ""
            val actualSource = if (source.isBlank() || source == "auto") detectLanguage(trimmed) else source
            if (actualSource == target) return@withContext text

            val translator = translators.getOrPut(actualSource to target) {
                Translation.getClient(
                    TranslatorOptions.Builder()
                        .setSourceLanguage(actualSource)
                        .setTargetLanguage(target)
                        .build()
                )
            }
            // Ensures both models are present. No-op when already downloaded.
            translator.downloadModelIfNeeded(DownloadConditions.Builder().build()).await()
            translator.translate(text).await()
        }

    fun close() {
        translators.values.forEach { it.close() }
        translators.clear()
    }
}