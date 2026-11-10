from pydantic import BaseModel, Field, model_validator


MAX_ANNOTATION_CHARACTERS = 60_000
MAX_TRANSLATION_CHARACTERS = 12_000


class JapaneseAnnotationRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=400)

    @model_validator(mode="after")
    def validate_total_length(self) -> "JapaneseAnnotationRequest":
        if sum(len(text) for text in self.texts) > MAX_ANNOTATION_CHARACTERS:
            raise ValueError(f"Annotation request exceeds {MAX_ANNOTATION_CHARACTERS} characters")
        return self


class JapaneseAnnotationSpan(BaseModel):
    text: str
    ruby: str | None = None


class JapaneseAnnotationResult(BaseModel):
    spans: list[JapaneseAnnotationSpan] = Field(default_factory=list)
    text: str


class JapaneseAnnotationResponse(BaseModel):
    annotations: list[JapaneseAnnotationResult] = Field(default_factory=list)


class JapaneseAiTranslationRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=24)
    work_title: str = Field(default="", max_length=255)
    chapter_title: str = Field(default="", max_length=255)

    @model_validator(mode="after")
    def validate_texts(self) -> "JapaneseAiTranslationRequest":
        if any(not text.strip() for text in self.texts):
            raise ValueError("Translation texts must not be empty")
        if sum(len(text) for text in self.texts) > MAX_TRANSLATION_CHARACTERS:
            raise ValueError(f"Translation request exceeds {MAX_TRANSLATION_CHARACTERS} characters")
        return self


class JapaneseAiTranslationResponse(BaseModel):
    model: str
    translations: list[str] = Field(default_factory=list)


class JapaneseLookupResponse(BaseModel):
    query: str
    reading: str | None = None
    dictionary_form: str | None = None
    translation: str | None = None
    english_glosses: list[str] = Field(default_factory=list)
    available: bool = False
