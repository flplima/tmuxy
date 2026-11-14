//! The file's JSON, read strictly.

/// JSON as the file is read: a key written twice in one object is an error.
/// A plain reader keeps the last, and the first may have held the deny.
pub(super) enum Json {
    Text(String),
    List(Vec<Json>),
    Object(Vec<(String, Json)>),
    Other,
}

impl<'de> serde::Deserialize<'de> for Json {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Reader;
        impl<'de> serde::de::Visitor<'de> for Reader {
            type Value = Json;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("JSON")
            }
            fn visit_str<E>(self, text: &str) -> Result<Json, E> {
                Ok(Json::Text(text.to_string()))
            }
            fn visit_bool<E>(self, _: bool) -> Result<Json, E> {
                Ok(Json::Other)
            }
            fn visit_i64<E>(self, _: i64) -> Result<Json, E> {
                Ok(Json::Other)
            }
            fn visit_u64<E>(self, _: u64) -> Result<Json, E> {
                Ok(Json::Other)
            }
            fn visit_f64<E>(self, _: f64) -> Result<Json, E> {
                Ok(Json::Other)
            }
            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Other)
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Json::List(items))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
                let mut entries: Vec<(String, Json)> = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, Json>()? {
                    if entries.iter().any(|(seen, _)| *seen == key) {
                        return Err(serde::de::Error::custom(format!(
                            "the key `{key}` is written twice in one object"
                        )));
                    }
                    entries.push((key, value));
                }
                Ok(Json::Object(entries))
            }
        }
        deserializer.deserialize_any(Reader)
    }
}

impl Json {
    pub(super) fn object(&self) -> Option<&[(String, Json)]> {
        match self {
            Json::Object(entries) => Some(entries),
            _ => None,
        }
    }
}
