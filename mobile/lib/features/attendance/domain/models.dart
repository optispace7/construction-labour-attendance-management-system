/// Domain models for attendance and workers.
library;

enum TapSource { nfcUid, nfcNdef, qr, manual }

extension TapSourceApi on TapSource {
  String get wire => switch (this) {
        TapSource.nfcUid => 'NFC_UID',
        TapSource.nfcNdef => 'NFC_NDEF',
        TapSource.qr => 'QR',
        TapSource.manual => 'MANUAL',
      };
}

/// What a scan did — or, before OK is pressed, would do — as the server
/// decided it. The phone never works this out for itself any more: its own
/// copy of who was on site could not see a login made at another gate, and
/// offered LOGIN to people the server then logged out.
///
/// `expired` is an ID card that has lapsed, so a login is refused.
/// `pendingApproval` is a hand-typed punch now waiting on a Safety Officer, and
/// `awaitingReview` is one already waiting for that person. `notFound` is a
/// badge or code that belongs to nobody active. `offline` means the server
/// could not be reached and nothing was recorded; `failed` is any other refusal,
/// with the server's words in the message.
enum TapAction {
  login,
  logout,
  duplicate,
  tooSoon,
  expired,
  pendingApproval,
  awaitingReview,
  notFound,
  offline,
  failed,
}

class WorkerCard {
  const WorkerCard({
    required this.id,
    required this.workerCode,
    required this.fullName,
    this.photoUrl,
    this.bloodGroup,
    this.emergencyContactName,
    this.emergencyContactNumber,
    this.nfcUid,
    this.qrIdentifier,
    this.vendorName,
    this.designationName,
    this.category,
    this.validityTill,
  });

  final String id;
  final String workerCode;
  final String fullName;
  final String? photoUrl;
  final String? bloodGroup;
  final String? emergencyContactName;
  final String? emergencyContactNumber;
  final String? nfcUid;
  final String? qrIdentifier;
  final String? vendorName;
  final String? designationName;
  final String? category; // WORKER | STAFF | VISITOR
  /// Last day the ID card is valid (inclusive). Null = never expires.
  final DateTime? validityTill;

  factory WorkerCard.fromMap(Map<String, dynamic> m) => WorkerCard(
        id: m['id'] as String,
        workerCode: (m['workerCode'] ?? '') as String,
        fullName: (m['fullName'] ?? '') as String,
        photoUrl: m['photoUrl'] as String?,
        bloodGroup: m['bloodGroup'] as String?,
        emergencyContactName: m['emergencyContactName'] as String?,
        emergencyContactNumber: m['emergencyContactNumber'] as String?,
        nfcUid: m['nfcUid'] as String?,
        qrIdentifier: m['qrIdentifier'] as String?,
        vendorName: m['vendorName'] as String?,
        designationName: m['designationName'] as String?,
        category: m['category'] as String?,
        validityTill: _parseDay(m['validityTill']),
      );
}

/// Parse a date-only or full ISO string; anything unusable reads as "no expiry"
/// so a malformed value can never lock a worker out of the gate.
DateTime? _parseDay(Object? v) {
  if (v is! String || v.isEmpty) return null;
  return DateTime.tryParse(v);
}
