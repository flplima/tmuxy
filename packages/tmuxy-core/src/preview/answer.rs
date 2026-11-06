/// A preview pane's document: its kind (`html` or `markdown`), its file
/// name, its text, and whether the page may reach the network.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PreviewDocument {
    pub kind: &'static str,
    pub name: String,
    pub text: String,
    pub net: bool,
}

/// A resource a preview document links: its type and its bytes in base64.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PreviewResource {
    pub mime: &'static str,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(untagged)]
pub enum PreviewRead {
    Document(PreviewDocument),
    Resource(PreviewResource),
}
