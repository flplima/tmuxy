#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::*;

/// A fresh folder holding a document and whatever the test writes beside it.
struct Folder(PathBuf);

impl Folder {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("tmuxy-preview-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn write(&self, relative: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        path
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn the_authorisation_is_asked_of_the_panes_own_options() {
    let pane = PaneId::parse("%12").unwrap();
    assert_eq!(
        authorisation_query(&pane),
        "display-message -p -t %12 '#{@tmuxy-pane-widget}' ; \
         display-message -p -t %12 '#{@tmuxy-pane-preview}' ; \
         display-message -p -t %12 '#{@tmuxy-pane-preview-net}'"
    );
}

#[test]
fn only_a_pane_tagged_as_a_preview_has_a_document() {
    assert_eq!(
        parse_authorisation("preview\n/tmp/a.md\n1\n").unwrap(),
        Authorisation {
            document: PathBuf::from("/tmp/a.md"),
            net: true
        }
    );
    assert!(!parse_authorisation("preview\n/tmp/a.md\n\n").unwrap().net);
    // Another widget's pane, a shell, a tag without a path, a relative path.
    for answer in [
        "tree\n/tmp/a.md\n",
        "\n\n\n",
        "preview\n\n\n",
        "preview\na.md\n",
    ] {
        assert_eq!(
            parse_authorisation(answer).unwrap_err().kind,
            crate::ErrorKind::Forbidden,
            "{answer:?}"
        );
    }
}

#[test]
fn the_document_is_read_with_its_kind_and_anything_else_is_refused() {
    let folder = Folder::new("document");
    let md = folder.write("notes.md", b"# Notes");
    let doc = read_document(&Authorisation {
        document: md,
        net: false,
    })
    .unwrap();
    assert_eq!(doc["kind"], "markdown");
    assert_eq!(doc["name"], "notes.md");
    assert_eq!(doc["text"], "# Notes");

    let html = folder.write("page.HTML", b"<h1>x</h1>");
    let doc = read_document(&Authorisation {
        document: html,
        net: true,
    })
    .unwrap();
    assert_eq!(doc["kind"], "html");
    assert_eq!(doc["net"], true);

    let key = folder.write("id_rsa", b"secret");
    assert!(read_document(&Authorisation {
        document: key,
        net: false
    })
    .is_err());
}

#[test]
fn a_document_that_is_not_a_regular_file_or_too_large_is_refused_before_the_read() {
    let folder = Folder::new("caps");
    let big = folder.0.join("big.md");
    std::fs::File::create(&big)
        .unwrap()
        .set_len(MAX_DOCUMENT_BYTES + 1)
        .unwrap();
    let error = read_document(&Authorisation {
        document: big,
        net: false,
    })
    .unwrap_err();
    assert!(error.error.contains("larger than"), "{error}");

    let dir = folder.0.join("folder.md");
    std::fs::create_dir_all(&dir).unwrap();
    let error = read_document(&Authorisation {
        document: dir,
        net: false,
    })
    .unwrap_err();
    assert!(error.error.contains("not a regular file"), "{error}");
}

#[test]
fn a_resource_inside_the_documents_folder_is_read() {
    let folder = Folder::new("resource");
    let doc = folder.write("page.html", b"");
    folder.write("css/site.css", b"body{}");
    folder.write("img/logo.png", &[0x89, b'P', b'N', b'G']);

    let css = read_resource(
        &Authorisation {
            document: doc.clone(),
            net: false,
        },
        "./css/site.css",
    )
    .unwrap();
    assert_eq!(css["mime"], "text/css; charset=utf-8");
    assert_eq!(css["data"], "Ym9keXt9");
    assert!(resolve_resource(&doc, "img/logo.png").is_ok());
}

#[test]
fn a_resource_cannot_leave_the_folder_or_name_a_hidden_file_or_a_plain_file() {
    let folder = Folder::new("escape");
    let doc = folder.write("site/page.html", b"");
    folder.write("secret.css", b"outside");
    folder.write("site/.env.css", b"hidden");
    folder.write("site/.git/hook.js", b"hidden");
    folder.write("site/notes.txt", b"a file, not a resource");
    for relative in [
        "../secret.css",
        "css/../../secret.css",
        "/etc/passwd.css",
        ".env.css",
        ".git/hook.js",
        "notes.txt",
        "",
        "a\\b.css",
        "a\0.css",
    ] {
        assert!(
            resolve_resource(&doc, relative).is_err(),
            "{relative:?} should be refused"
        );
    }
}

#[cfg(unix)]
#[test]
fn a_symlink_cannot_carry_a_resource_out_of_the_folder_or_onto_a_hidden_file() {
    let folder = Folder::new("symlink");
    let doc = folder.write("site/page.html", b"");
    let outside = folder.write("outside.css", b"outside");
    let hidden = folder.write("site/.secret.css", b"hidden");
    std::os::unix::fs::symlink(&outside, folder.0.join("site/out.css")).unwrap();
    std::os::unix::fs::symlink(&hidden, folder.0.join("site/in.css")).unwrap();
    assert!(resolve_resource(&doc, "out.css").is_err());
    assert!(resolve_resource(&doc, "in.css").is_err());
}

#[test]
fn a_page_is_sandboxed_and_offline_unless_opened_with_net() {
    let offline = page_csp(false);
    assert!(offline.starts_with("sandbox allow-scripts;"), "{offline}");
    assert!(!offline.contains("allow-same-origin"), "{offline}");
    assert!(offline.contains("connect-src 'none'"), "{offline}");
    assert!(!offline.contains("https:"), "{offline}");

    let online = page_csp(true);
    assert!(online.starts_with("sandbox allow-scripts;"), "{online}");
    assert!(
        online.contains("img-src data: blob: https: http:"),
        "{online}"
    );
}

#[test]
fn a_staged_page_replaces_the_panes_last_and_the_store_is_bounded() {
    let pages = PreviewPages::default();
    let pane = |n: u32| PaneId::parse(&format!("%{n}")).unwrap();
    pages.stage(pane(1), "one".into(), false).unwrap();
    pages.stage(pane(1), "two".into(), true).unwrap();
    let page = pages.page(&pane(1)).unwrap();
    assert_eq!(page.html, "two");
    assert_eq!(page.csp, page_csp(true));

    for n in 2..=STAGED_PAGES as u32 + 1 {
        pages.stage(pane(n), "x".into(), false).unwrap();
    }
    assert!(pages.page(&pane(1)).is_none(), "the oldest page goes first");
    assert!(pages
        .stage(pane(1), "x".repeat(MAX_STAGED_BYTES + 1), false)
        .is_err());
}
